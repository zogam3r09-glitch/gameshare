import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionQuality,
  ConnectionState,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
} from 'livekit-client';
import { createLogger, errorMessage, isPublisherIdentity, isViewerIdentity } from '@game-share/shared';
import { ViewerApiError, fetchViewerToken } from './api.js';

const log = createLogger('viewer');

export type WatchPhase =
  | 'connecting'
  /** conectado, mas o streamer ainda nao publicou (ou ja saiu) */
  | 'waiting'
  | 'playing'
  | 'ended'
  | 'error';

export interface WatchState {
  phase: WatchPhase;
  error: string | null;
  notice: string | null;
  viewers: number;
  quality: ConnectionQuality;
  connection: ConnectionState;
  hasAudio: boolean;
  /** o navegador bloqueou o autoplay do audio: precisa de um clique */
  audioBlocked: boolean;
}

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
  error: null,
  notice: null,
  viewers: 0,
  quality: ConnectionQuality.Unknown,
  connection: ConnectionState.Disconnected,
  hasAudio: false,
  audioBlocked: false,
};

export interface UseWatchRoom extends WatchState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  enableAudio: () => void;
}

export function useWatchRoom(roomId: string): UseWatchRoom {
  const [state, setState] = useState<WatchState>(INITIAL);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roomRef = useRef<Room | null>(null);

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

      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          const track = publication.track;
          if (track instanceof RemoteVideoTrack && videoRef.current) {
            track.attach(videoRef.current);
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
        const { token, livekitUrl } = await fetchViewerToken(roomId);
        if (cancelled) return;
        await room.connect(livekitUrl, token);
        if (cancelled) return;

        log.info('conectado', { roomId });
        // as tracks podem ter sido assinadas durante o connect acima
        sync();
      } catch (err) {
        if (cancelled) return;
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

  return { ...state, videoRef, audioRef, enableAudio };
}
