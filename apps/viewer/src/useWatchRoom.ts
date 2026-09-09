import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionQuality,
  ConnectionState,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
} from 'livekit-client';
import {
  AMOSTRA_ENTRADA_VAZIA,
  createLogger,
  errorMessage,
  isPublisherIdentity,
  isViewerIdentity,
  lerAmostraEntrada,
  type RtcSampleEntrada,
} from '@game-share/shared';
import { ViewerApiError, fetchViewerToken } from './api.js';

const log = createLogger('viewer');

export type WatchPhase =
  | 'connecting'
  /** conectado, mas o streamer ainda nao publicou (ou ja saiu) */
  | 'waiting'
  | 'playing'
  | 'ended'
  | 'error';

/** Metricas do lado que RECEBE, mais o playout delay, que nao vem do report. */
export interface ReceiveStats extends RtcSampleEntrada {
  /** atraso de reproducao pedido ao Chromium, em ms */
  playoutDelayMs: number | null;
}

const EMPTY_RECEIVE: ReceiveStats = { ...AMOSTRA_ENTRADA_VAZIA, playoutDelayMs: null };

export interface WatchState {
  phase: WatchPhase;
  stats: ReceiveStats;
  error: string | null;
  notice: string | null;
  viewers: number;
  quality: ConnectionQuality;
  connection: ConnectionState;
  hasAudio: boolean;
  /** o navegador bloqueou o autoplay do audio: precisa de um clique */
  audioBlocked: boolean;
  /** video suspenso porque a aba ficou escondida; o audio continua */
  videoPausado: boolean;
}

/**
 * Quanto tempo a aba precisa ficar escondida antes de suspender o video.
 *
 * Nao e zero de proposito. Retomar custa a rampa do encoder — a mesma que
 * fazia o primeiro espectador ver 320x180 por 24 s — entao alternar de aba por
 * dois segundos nao pode disparar isso. Meio minuto separa "trocou de janela"
 * de "foi embora e esqueceu aberto", que e o caso que gasta banda a toa.
 */
const ATRASO_PAUSA_MS = Number(
  (import.meta.env.VITE_PAUSE_DELAY_MS as string | undefined) ?? 30_000,
);

/**
 * Fase derivada do estado real da sala.
 *
 * Nunca dependa da ordem dos eventos: `TrackSubscribed` dispara DURANTE
 * `room.connect()`, ou seja antes do codigo que roda depois do await. Foi
 * exatamente isso que travava o viewer em "Aguardando transmissao..." para
 * sempre — o pos-connect sobrescrevia um `playing` que ja tinha acontecido.
 */
export function nextPhase(current: WatchPhase, hasVideo: boolean, hasPublisher: boolean): WatchPhase {
  if (current === 'error') return current;
  if (hasVideo) return 'playing';
  if (hasPublisher) return 'waiting';
  // sem publisher: so e "encerrada" se a transmissao chegou a rodar
  if (current === 'playing') return 'ended';
  return current === 'connecting' ? 'waiting' : current;
}

const INITIAL: WatchState = {
  phase: 'connecting',
  stats: EMPTY_RECEIVE,
  error: null,
  notice: null,
  viewers: 0,
  quality: ConnectionQuality.Unknown,
  connection: ConnectionState.Disconnected,
  hasAudio: false,
  audioBlocked: false,
  videoPausado: false,
};

export interface UseWatchRoom extends WatchState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  enableAudio: () => void;
}

async function sampleReceive(track: RemoteVideoTrack): Promise<ReceiveStats | null> {
  let report: RTCStatsReport | undefined;
  try {
    report = await track.getRTCStatsReport();
  } catch {
    return null;
  }
  if (!report) return null;

  // O parsing vive em @game-share/shared: o desktop le as estatisticas de
  // envio e o viewer as de recepcao, e antes havia codigo parecido nos dois.
  const out: ReceiveStats = { ...lerAmostraEntrada(report), playoutDelayMs: null };

  try {
    const delay = track.getPlayoutDelay();
    if (typeof delay === 'number') out.playoutDelayMs = Math.round(delay * 1000);
  } catch {
    // nem todo navegador expoe playoutDelayHint
  }

  return out;
}

export function useWatchRoom(roomId: string): UseWatchRoom {
  const [state, setState] = useState<WatchState>(INITIAL);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const videoTrackRef = useRef<RemoteVideoTrack | null>(null);
  /**
   * Se o video esta suspenso por aba escondida.
   *
   * Medido: `setEnabled(false)` NAO cancela a assinatura — a faixa continua
   * anexada e o calculo de fase segue vendo "tem video" sozinho. Por isso este
   * ref nao entra em `sync()`: cheguei a por um guarda la e ele nao era
   * necessario. Serve so para saber se ha o que retomar.
   */
  const pausadoRef = useRef(false);

  const patch = useCallback((p: Partial<WatchState>) => setState((s) => ({ ...s, ...p })), []);

  const enableAudio = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    room
      .startAudio()
      .then(() => patch({ audioBlocked: false }))
      .catch((err: unknown) => log.warn('startAudio falhou', { message: errorMessage(err) }));
  }, [patch]);

  useEffect(() => {
    let cancelled = false;
    const room = new Room({
      // viewer unico e em tela cheia: adaptiveStream so adicionaria oscilacao
      adaptiveStream: false,
    });
    roomRef.current = room;

    const countViewers = (): number => {
      let n = 1; // eu
      room.remoteParticipants.forEach((p) => {
        if (isViewerIdentity(p.identity)) n++;
      });
      return n;
    };

    const hasPublisher = (): boolean => {
      let found = false;
      room.remoteParticipants.forEach((p) => {
        if (isPublisherIdentity(p.identity)) found = true;
      });
      return found;
    };

    /**
     * Anexa tudo que ja esta assinado e recalcula o estado a partir da sala.
     * Idempotente de proposito: pode ser chamado por qualquer evento, em
     * qualquer ordem, inclusive depois de `room.connect()` resolver.
     */
    const sync = (): void => {
      let hasVideo = false;
      let hasAudio = false;
      videoTrackRef.current = null;

      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          const track = publication.track;
          if (track instanceof RemoteVideoTrack && videoRef.current) {
            track.attach(videoRef.current);
            videoTrackRef.current = track;
            hasVideo = true;
          } else if (track instanceof RemoteAudioTrack && audioRef.current) {
            track.attach(audioRef.current);
            hasAudio = true;
          }
        });
      });

      setState((s) => {
        const phase = nextPhase(s.phase, hasVideo, hasPublisher());
        return {
          ...s,
          phase,
          hasAudio,
          viewers: countViewers(),
          audioBlocked: !room.canPlaybackAudio,
          notice: phase === 'playing' ? null : s.notice,
        };
      });
    };

    room
      .on(RoomEvent.TrackSubscribed, (track) => {
        log.info('track assinada', { kind: track.kind, source: track.source });
        sync();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        log.info('track encerrada', { kind: track.kind });
        track.detach();
        sync();
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        log.info('participante entrou', { identity: p.identity });
        sync();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (isPublisherIdentity(p.identity)) log.info('streamer saiu');
        sync();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.identity === room.localParticipant.identity) patch({ quality });
      })
      .on(RoomEvent.ConnectionStateChanged, (connection) => patch({ connection }))
      .on(RoomEvent.Reconnecting, () => patch({ notice: 'Conexão instável — reconectando…' }))
      .on(RoomEvent.Reconnected, () => {
        patch({ notice: null });
        sync();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () =>
        patch({ audioBlocked: !room.canPlaybackAudio }),
      )
      .on(RoomEvent.Disconnected, (reason) => {
        log.warn('desconectado', { reason });
        setState((s) => (s.phase === 'error' ? s : { ...s, phase: 'ended' }));
      });

    void (async () => {
      try {
        const { token, livekitUrl } = await fetchViewerToken(roomId, () =>
          patch({ notice: 'Acordando o servidor… isso pode levar até um minuto.' }),
        );
        if (cancelled) return;
        await room.connect(livekitUrl, token);
        if (cancelled) return;

        log.info('conectado', { roomId });
        patch({ notice: null });
        // as tracks podem ter sido assinadas durante o connect acima
        sync();
      } catch (err) {
        if (cancelled) return;

        // "ja encerrada" nao e erro: e o mesmo desfecho de quem estava
        // assistindo quando o streamer parou, e merece a mesma tela.
        if (err instanceof ViewerApiError && err.kind === 'ended') {
          log.info('sala ja encerrada quando o link foi aberto', { roomId });
          patch({ phase: 'ended' });
          return;
        }

        const message =
          err instanceof ViewerApiError
            ? err.message
            : `Não foi possível conectar à transmissão. ${errorMessage(err)}`;
        log.error('falha ao conectar', { message });
        patch({ phase: 'error', error: message });
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      void room.disconnect();
      roomRef.current = null;
    };
  }, [roomId, patch]);

  /**
   * Aba escondida por mais de 30 s: manda o servidor parar de enviar VIDEO.
   *
   * Aba minimizada continua baixando vídeo hoje, e quem esquece a aba aberta e
   * uma fatia real do consumo. O audio segue tocando de proposito — muita gente
   * deixa a transmissao rodando so para ouvir enquanto faz outra coisa, e audio
   * custa ~12% do que o video custa.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const publicacaoDeVideo = () => {
      const room = roomRef.current;
      if (!room) return null;
      for (const participante of room.remoteParticipants.values()) {
        for (const pub of participante.trackPublications.values()) {
          if (pub.kind === 'video') return pub;
        }
      }
      return null;
    };

    const definir = (enviar: boolean): void => {
      const pub = publicacaoDeVideo();
      if (!pub) return;
      pausadoRef.current = !enviar;
      pub.setEnabled(enviar);
      patch({ videoPausado: !enviar });
      log.info(enviar ? 'video retomado' : 'video suspenso: aba escondida');
    };

    const aoMudar = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (document.hidden) {
        timer = setTimeout(() => definir(false), ATRASO_PAUSA_MS);
      } else if (pausadoRef.current) {
        definir(true);
      }
    };

    document.addEventListener('visibilitychange', aoMudar);
    return () => {
      document.removeEventListener('visibilitychange', aoMudar);
      if (timer) clearTimeout(timer);
      // nao deixa a track desabilitada para o proximo render
      if (pausadoRef.current) definir(true);
    };
  }, [patch]);

  /**
   * `jitterBufferMs` e o numero que explica "lag do mouse": quanto tempo cada
   * quadro fica represado antes de ser exibido. O Chromium aumenta esse buffer
   * sozinho quando ve jitter na rede, trocando latencia por suavidade.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const track = videoTrackRef.current;
      if (!track) return;
      void sampleReceive(track).then((stats) => {
        if (!stats) return;
        setState((s) => ({ ...s, stats }));
        log.debug('metricas de recepcao', { ...stats });
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  return { ...state, videoRef, audioRef, enableAudio };
}
