import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  createLogger,
  errorMessage,
  isViewerIdentity,
  kbpsEntreAmostras,
  lerAmostra,
  type MarcaBytes,
  type CaptureSource,
  type CreateRoomResponse,
  type QualityPresetName,
} from '@game-share/shared';
import { TokenServerError, createRoom, endRoom } from './api.js';

const log = createLogger('broadcast');

export type BroadcastPhase =
  | 'idle'
  | 'creating'
  | 'choosing'
  | 'starting'
  | 'live'
  | 'ending'
  | 'error';

export interface LiveStats {
  width: number | null;
  height: number | null;
  /**
   * fps CONFIGURADO na faixa (getSettings). Nao e medicao: devolve o que foi
   * pedido, mesmo que a captura entregue menos. Nao use para diagnostico.
   */
  captureFps: number | null;
  /**
   * fps REAL produzido pela fonte (media-source). Este e medido.
   * Se bater com `encodedFps`, o encoder nao esta perdendo nada e o limite
   * esta na captura; se for bem maior, ai sim o gargalo e a codificacao.
   */
  sourceFps: number | null;
  /**
   * Segundos acumulados em cada motivo de limitacao. Responde de forma
   * definitiva se ha limite de CPU, sem depender do qualityLimitationReason
   * instantaneo, que reporta "none" com frequencia enganosa.
   */
  limitedByCpuSeconds: number | null;
  limitedByBandwidthSeconds: number | null;
  /** fps realmente codificado e enviado (RTCStats publico); null se indisponivel */
  encodedFps: number | null;
  /** kbps de video calculado por delta de bytesSent; null antes da 2a amostra */
  videoKbps: number | null;
  /** implementacao do encoder; revela se e software (libvpx) ou hardware */
  encoder: string | null;
  /** o que esta limitando a qualidade: 'cpu', 'bandwidth', 'none'… */
  limitedBy: string | null;
  /** quadros que o encoder deixou cair por nao dar conta */
  framesDropped: number | null;
  /**
   * Resolucao REALMENTE codificada e enviada, que pode ser menor que a
   * capturada: com degradationPreference 'maintain-framerate' o WebRTC reduz
   * resolucao para segurar o framerate, e o viewer reamplia — isso aparece
   * como blur. `resolucao` sozinha (que vem da captura) esconde esse caso.
   */
  encodedWidth: number | null;
  encodedHeight: number | null;
  /** estimativa de banda de saida (BWE). Se desaba, o encoder desaba junto. */
  availableKbps: number | null;
  /** RTT do par de candidatos ICE em uso */
  rttMs: number | null;
  /** pedidos de retransmissao e de keyframe vindos do outro lado */
  nack: number | null;
  pli: number | null;
  viewers: number;
  quality: ConnectionQuality;
  connection: ConnectionState;
  hasAudio: boolean;
}

export interface BroadcastState {
  phase: BroadcastPhase;
  room: CreateRoomResponse | null;
  sources: CaptureSource[];
  sourcesLoading: boolean;
  selectedSourceId: string | null;
  preset: QualityPresetName;
  stats: LiveStats;
  /** erro fatal: a UI mostra a tela de erro */
  error: string | null;
  /** aviso nao fatal, ex.: transmissao sem audio */
  notice: string | null;
}

const EMPTY_STATS: LiveStats = {
  width: null,
  height: null,
  captureFps: null,
  sourceFps: null,
  limitedByCpuSeconds: null,
  limitedByBandwidthSeconds: null,
  encodedFps: null,
  videoKbps: null,
  encoder: null,
  limitedBy: null,
  framesDropped: null,
  availableKbps: null,
  rttMs: null,
  nack: null,
  pli: null,
  encodedWidth: null,
  encodedHeight: null,
  viewers: 0,
  quality: ConnectionQuality.Unknown,
  connection: ConnectionState.Disconnected,
  hasAudio: false,
};

const INITIAL: BroadcastState = {
  phase: 'idle',
  room: null,
  sources: [],
  sourcesLoading: false,
  selectedSourceId: null,
  preset: DEFAULT_PRESET,
  stats: EMPTY_STATS,
  error: null,
  notice: null,
};

const DISCONNECT_REASON_PT: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.CLIENT_INITIATED]: 'Transmissao encerrada por voce.',
  [DisconnectReason.DUPLICATE_IDENTITY]: 'Outra sessao assumiu esta transmissao.',
  [DisconnectReason.SERVER_SHUTDOWN]: 'O servidor LiveKit foi desligado.',
  [DisconnectReason.PARTICIPANT_REMOVED]: 'Voce foi removido da sala.',
  [DisconnectReason.ROOM_DELETED]: 'A sala foi encerrada no servidor.',
  [DisconnectReason.JOIN_FAILURE]: 'Nao foi possivel entrar na sala.',
};

export class Broadcaster {
  private state: BroadcastState = INITIAL;
  private listeners = new Set<(s: BroadcastState) => void>();

  private room: Room | null = null;
  private stream: MediaStream | null = null;
  private videoTrack: LocalVideoTrack | null = null;
  private audioTrack: LocalAudioTrack | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastBytesSent: MarcaBytes | null = null;
  private statsTick = 0;

  subscribe(listener: (s: BroadcastState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<BroadcastState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private setStats(patch: Partial<LiveStats>): void {
    this.set({ stats: { ...this.state.stats, ...patch } });
  }

  private failure(message: string): void {
    log.error('falha na transmissao', { message });
    this.set({ phase: 'error', error: message });
    void this.teardown();
  }

  // -------------------------------------------------------------------------
  // 1. criar sala
  // -------------------------------------------------------------------------
  async createBroadcast(): Promise<void> {
    this.set({ phase: 'creating', error: null, notice: null });
    try {
      const room = await createRoom();
      log.info('sala criada', { roomId: room.roomId, watchUrl: room.watchUrl });
      this.set({ phase: 'choosing', room });
      await this.refreshSources();
    } catch (err) {
      const msg =
        err instanceof TokenServerError
          ? err.message
          : `Nao foi possivel criar a transmissao: ${errorMessage(err)}`;
      this.set({ phase: 'error', error: msg });
    }
  }

  // -------------------------------------------------------------------------
  // 2. escolher fonte
  // -------------------------------------------------------------------------
  async refreshSources(): Promise<void> {
    this.set({ sourcesLoading: true });
    try {
      const sources = await window.gameShare.listCaptureSources();
      const stillThere = sources.some((s) => s.id === this.state.selectedSourceId);
      this.set({
        sources,
        sourcesLoading: false,
        selectedSourceId: stillThere ? this.state.selectedSourceId : null,
        notice:
          sources.length === 0
            ? 'Nenhuma fonte de captura encontrada. Verifique as permissoes de gravacao de tela do Windows.'
            : this.state.notice,
      });
    } catch (err) {
      this.set({ sourcesLoading: false });
      this.failure(`Nao foi possivel listar as fontes de captura: ${errorMessage(err)}`);
    }
  }

  selectSource(sourceId: string): void {
    this.set({ selectedSourceId: sourceId });
  }

  /** Só tem efeito antes de iniciar: o preset é aplicado na captura. */
  setPreset(preset: QualityPresetName): void {
    if (this.state.phase === 'choosing') this.set({ preset });
  }

  // -------------------------------------------------------------------------
  // 3. capturar + publicar
  // -------------------------------------------------------------------------
  async start(): Promise<void> {
    const { room: created, selectedSourceId } = this.state;
    if (!created || !selectedSourceId) return;

    this.set({ phase: 'starting', error: null, notice: null });
    const preset = QUALITY_PRESETS[this.state.preset];

    // arma a fonte escolhida no main process; sem isso getDisplayMedia e negado
    const armed = await window.gameShare.selectCaptureSource(selectedSourceId);
    if (!armed) {
      this.failure('A fonte escolhida nao e mais valida. Atualize a lista e tente de novo.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // `max`, nao `ideal`: o capturador de tela do Chromium trata `ideal`
        // como sugestao e ignora. Medido em transmissao real pedindo 720p30
        // com `ideal`: a captura veio em 1920x1080@60 e o libvpx so conseguiu
        // codificar ~15fps disso.
        video: {
          width: { max: preset.width },
          height: { max: preset.height },
          frameRate: { max: preset.frameRate },
        },
        audio: true,
      });
    } catch (err) {
      await window.gameShare.clearCaptureSource();
      const name = err instanceof DOMException ? err.name : '';
      this.failure(
        name === 'NotAllowedError'
          ? 'Permissao de captura negada. Autorize a gravacao de tela em Configuracoes do Windows > Privacidade e seguranca > Gravacao de tela.'
          : `Falha ao capturar a fonte: ${errorMessage(err)}`,
      );
      return;
    }
    await window.gameShare.clearCaptureSource();

    const videoMst = stream.getVideoTracks()[0];
    if (!videoMst) {
      stream.getTracks().forEach((t) => t.stop());
      this.failure('A captura nao retornou video.');
      return;
    }

    /**
     * Diz ao encoder que isto e conteudo em movimento, nao um documento.
     *
     * Sem contentHint o Chromium trata captura de tela como conteudo estatico e
     * prioriza nitidez sobre fluidez — derrubando o framerate para manter a
     * resolucao. Para jogo queremos o contrario. O livekit-client so define
     * contentHint sozinho em createScreenTracks ou com codecs SVC, e aqui o
     * LocalVideoTrack e construido na mao, entao precisa ser explicito.
     */
    videoMst.contentHint = 'motion';

    // Cinto e suspensorio: mesmo com `max` na requisicao, reaplicamos e
    // registramos o que ficou valendo de fato. Sem este log o descompasso
    // entre o pedido e a captura passa despercebido.
    try {
      await videoMst.applyConstraints({
        width: { max: preset.width },
        height: { max: preset.height },
        frameRate: { max: preset.frameRate },
      });
    } catch (err) {
      log.warn('applyConstraints falhou na faixa de captura', { message: errorMessage(err) });
    }

    // Nao logamos getSettings() aqui: antes do primeiro quadro ele devolve a
    // constraint pedida, nao o que a captura entrega de fato — ja mentiu
    // dizendo 2560x1440 numa captura que era 1920x1080. O valor real sai na
    // linha de metricas, junto com o `pedido` para comparacao.

    const audioMst = stream.getAudioTracks()[0] ?? null;
    if (!audioMst) {
      await window.gameShare.reportAudioUnavailable();
      log.warn('captura sem faixa de audio (loopback indisponivel)');
    }

    this.stream = stream;
    this.set({
      notice: audioMst
        ? null
        : 'Sem audio: o Windows nao entregou o loopback do sistema. O video segue normalmente.',
    });

    // a faixa termina sozinha se a janela capturada for fechada
    videoMst.addEventListener('ended', () => {
      log.warn('faixa de video encerrada (fonte fechada?)');
      if (this.state.phase === 'live') {
        this.set({ notice: 'A janela/monitor capturado foi fechado. Transmissao encerrada.' });
        void this.stop();
      }
    });

    const room = new Room({
      adaptiveStream: false, // publisher nao precisa; reduz variacao de latencia
      /**
       * dynacast DESLIGADO de proposito, apesar de economizar upload ocioso.
       *
       * Ele serve para parar de codificar CAMADAS que ninguem assina, e aqui
       * simulcast e false: existe uma camada so. Entao nao ha o que gerenciar,
       * e a unica coisa que ele fazia era pausar essa camada enquanto a sala
       * estava vazia — o que custava caro na hora que importa.
       *
       * Medido: com dynacast ligado e 0 espectadores, a estimativa de banda
       * apodrecia de 6961 para 5 kbps (nada sendo enviado). O primeiro
       * espectador religava o encoder a partir desse chao e, como a
       * degradationPreference e maintain-framerate, o orcamento minusculo ia
       * todo para 60 fps e sobrava 320x180. A subida ate 1080p levava 24s:
       *
       *   320x180 175kbps -> 480x270 -> 1280x720 -> 1920x1080 3023kbps
       *
       * Contraprova: reconectar numa transmissao ja quente entregava 1080p58
       * imediatamente, sem rampa. Ou seja, era cold start, nao por assinante.
       *
       * E o primeiro espectador e sempre o amigo que estava esperando o link.
       * Preferimos gastar upload com a sala vazia a entregar 24s de 180p.
       */
      dynacast: false,
      disconnectOnPageLeave: true,
    });
    this.room = room;
    this.wireRoomEvents(room);

    try {
      await room.connect(created.livekitUrl, created.token);
      log.info('conectado ao LiveKit', { url: created.livekitUrl, roomId: created.roomId });
    } catch (err) {
      this.failure(
        `Nao foi possivel conectar ao LiveKit em ${created.livekitUrl}. ` +
          `Confirme se o servidor esta no ar ("pnpm livekit:dev"). Detalhe: ${errorMessage(err)}`,
      );
      return;
    }

    try {
      this.videoTrack = new LocalVideoTrack(videoMst);
      await room.localParticipant.publishTrack(this.videoTrack, {
        name: 'screen',
        source: Track.Source.ScreenShare,
        simulcast: false, // POC: uma camada so, menos CPU e menos latencia
        /**
         * `screenShareEncoding`, NAO `videoEncoding`.
         *
         * Para source ScreenShare o livekit-client le exclusivamente
         * screenShareEncoding e ignora videoEncoding em silencio. O padrao e
         * ScreenSharePresets.h1080fps15, ou seja um teto de 15 FPS. Foi o que
         * segurou a transmissao em 14-16 fps mesmo depois de a captura passar
         * a entregar 720p30 certinho.
         */
        screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate },
        degradationPreference: 'maintain-framerate', // jogo: preferimos fps a nitidez
      });
      log.info('video publicado', { preset: preset.name });

      if (audioMst) {
        this.audioTrack = new LocalAudioTrack(audioMst);
        await room.localParticipant.publishTrack(this.audioTrack, {
          name: 'system-audio',
          source: Track.Source.ScreenShareAudio,
          dtx: false, // audio de jogo e continuo; DTX corta trechos
          red: false,
          forceStereo: true,
        });
        log.info('audio do sistema publicado');
      }
    } catch (err) {
      this.failure(`Falha ao publicar as faixas no LiveKit: ${errorMessage(err)}`);
      return;
    }

    this.set({ phase: 'live' });
    this.setStats({ hasAudio: Boolean(audioMst), connection: room.state });
    this.startStatsPolling();
  }

  // -------------------------------------------------------------------------
  // 4. eventos da sala
  // -------------------------------------------------------------------------
  private countViewers(room: Room): number {
    let n = 0;
    room.remoteParticipants.forEach((p) => {
      if (isViewerIdentity(p.identity)) n++;
    });
    return n;
  }

  private wireRoomEvents(room: Room): void {
    const syncViewers = (): void => this.setStats({ viewers: this.countViewers(room) });

    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        log.info('participante entrou', { identity: p.identity });
        syncViewers();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        log.info('participante saiu', { identity: p.identity });
        syncViewers();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.identity === room.localParticipant.identity) {
          this.setStats({ quality });
        }
      })
      .on(RoomEvent.ConnectionStateChanged, (connection) => {
        log.info('estado da conexao', { connection });
        this.setStats({ connection });
      })
      .on(RoomEvent.Reconnecting, () => {
        log.warn('reconectando ao LiveKit');
        this.set({ notice: 'Conexao instavel — reconectando…' });
      })
      .on(RoomEvent.Reconnected, () => {
        log.info('reconectado ao LiveKit');
        this.set({ notice: null });
        syncViewers();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        log.warn('desconectado do LiveKit', { reason });
        if (this.state.phase !== 'live' && this.state.phase !== 'starting') return;
        const known = reason !== undefined ? DISCONNECT_REASON_PT[reason] : undefined;
        if (reason === DisconnectReason.CLIENT_INITIATED) return;
        this.failure(known ?? 'Conexao com o LiveKit perdida.');
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        log.warn('faixa local despublicada', { source: pub.source });
      });
  }

  // -------------------------------------------------------------------------
  // 5. metricas (somente API publica do SDK)
  // -------------------------------------------------------------------------
  private startStatsPolling(): void {
    this.stopStatsPolling();
    this.lastBytesSent = null;
    const tick = (): void => void this.sampleStats();
    tick();
    this.statsTimer = setInterval(tick, 1500);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async sampleStats(): Promise<void> {
    const track = this.videoTrack;
    if (!track) return;

    const settings = track.mediaStreamTrack.getSettings();
    this.setStats({
      width: settings.width ?? null,
      height: settings.height ?? null,
      captureFps: settings.frameRate ? Math.round(settings.frameRate) : null,
    });

    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch (err) {
      log.debug('getRTCStatsReport indisponivel', { message: errorMessage(err) });
      return;
    }
    if (!report) return;

    const amostra = lerAmostra(report);

    let videoKbps = this.state.stats.videoKbps;
    if (amostra.videoBytesSent !== null) {
      const marca = { bytes: amostra.videoBytesSent, at: performance.now() };
      videoKbps = kbpsEntreAmostras(this.lastBytesSent, marca) ?? videoKbps;
      this.lastBytesSent = marca;
    }

    const {
      encodedFps,
      sourceFps,
      encoder,
      limitedBy,
      framesDropped,
      availableKbps,
      rttMs,
      nack,
      pli,
      encodedWidth,
      encodedHeight,
      limitedByCpuSeconds,
      limitedByBandwidthSeconds,
    } = amostra;

    this.setStats({
      encodedFps,
      videoKbps,
      encoder,
      limitedBy,
      framesDropped,
      availableKbps,
      rttMs,
      nack,
      pli,
      encodedWidth,
      encodedHeight,
      sourceFps,
      limitedByCpuSeconds,
      limitedByBandwidthSeconds,
    });

    // Uma linha a cada ~6s no terminal. Sem isto o diagnostico so existe na
    // UI, e ninguem consegue reconstruir depois o que aconteceu durante o jogo.
    if (this.statsTick++ % 4 === 0) {
      const s = this.state.stats;
      const wanted = QUALITY_PRESETS[this.state.preset];
      log.info('metricas', {
        pedido: `${wanted.width}x${wanted.height}@${wanted.frameRate}`,
        capturado: s.width && s.height ? `${s.width}x${s.height}` : null,
        // se for menor que `capturado`, o encoder reduziu para segurar o fps
        codificado: encodedWidth && encodedHeight ? `${encodedWidth}x${encodedHeight}` : null,
        // fpsPedido e configuracao; fpsFonte e o que a captura entrega de fato
        fpsPedido: s.captureFps,
        fpsFonte: sourceFps,
        fpsCodificado: encodedFps,
        segLimitadoCpu: limitedByCpuSeconds,
        segLimitadoBanda: limitedByBandwidthSeconds,
        kbps: videoKbps,
        encoder,
        gargalo: limitedBy,
        bweKbps: availableKbps,
        rttMs,
        nack,
        pli,
        quadrosPerdidos: framesDropped,
        espectadores: s.viewers,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. encerrar
  // -------------------------------------------------------------------------
  async stop(): Promise<void> {
    if (this.state.phase === 'ending' || this.state.phase === 'idle') return;
    this.set({ phase: 'ending' });
    await this.teardown();
    this.set({
      phase: 'idle',
      room: null,
      sources: [],
      selectedSourceId: null,
      stats: EMPTY_STATS,
      error: null,
    });
    log.info('transmissao encerrada');
  }

  /** Volta para a tela inicial depois de um erro. */
  reset(): void {
    void this.teardown().then(() => this.set({ ...INITIAL }));
  }

  private async teardown(): Promise<void> {
    this.stopStatsPolling();

    if (this.room) {
      const room = this.room;
      this.room = null;
      room.removeAllListeners();
      try {
        await room.disconnect();
      } catch (err) {
        log.warn('erro ao desconectar do LiveKit', { message: errorMessage(err) });
      }
    }

    // derruba os espectadores agora em vez de esperar o emptyTimeout do SFU
    const created = this.state.room;
    if (created) {
      const ok = await endRoom(created.roomId, created.token);
      log.info(ok ? 'sala encerrada no SFU' : 'sala nao pode ser encerrada no SFU', {
        roomId: created.roomId,
      });
    }

    for (const t of [this.videoTrack, this.audioTrack]) {
      if (!t) continue;
      try {
        t.stop();
      } catch (err) {
        log.warn('erro ao parar faixa', { message: errorMessage(err) });
      }
    }
    this.videoTrack = null;
    this.audioTrack = null;

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    await window.gameShare.clearCaptureSource().catch(() => undefined);
  }
}
