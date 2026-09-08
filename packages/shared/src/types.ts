/** Fonte de captura exposta pelo main process do Electron ao renderer. */
export interface CaptureSource {
  /** id opaco do desktopCapturer (`screen:0:0`, `window:1234:0`) */
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** data: URL PNG do preview (pode ser string vazia se o preview falhar) */
  thumbnailDataUrl: string;
}

export type QualityPresetName =
  | '720p30'
  | '720p60'
  | '1080p30'
  | '1080p60'
  | '1440p30'
  | '1440p60'
  | '4k30';

export interface QualityPreset {
  name: QualityPresetName;
  width: number;
  height: number;
  frameRate: number;
  /** bitrate maximo de video em bits/s */
  maxBitrate: number;
  /**
   * Aviso curto exibido no seletor quando o preset pede mais do que a
   * codificacao por software costuma entregar. Null = dentro do envelope.
   */
  warning: string | null;
}

/**
 * Teto pratico medido nesta maquina (AMD RX 6700, encoder libvpx por software):
 * ~32 fps a 1920x1080, ou seja cerca de 124 milhoes de pixels por segundo.
 * Presets acima disso entram na lista, mas com aviso — a alternativa seria
 * escondê-los e deixar o usuario descobrir sozinho por que trava.
 */
export const SOFTWARE_ENCODER_PIXELS_PER_SECOND = 124_000_000;

export function pixelsPerSecond(p: QualityPreset): number {
  return p.width * p.height * p.frameRate;
}

/**
 * Ordem = ordem do seletor. Lembre que a resolucao e TETO: numa tela menor a
 * captura sai nativa, e o que muda de fato entre presets e bitrate e fps.
 *
 * `maxBitrate` tambem e teto, nunca piso — numa rede pior o WebRTC usa menos
 * sozinho. Por isso valores generosos nao prejudicam quem tem upload ruim.
 */
export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  // 28 Mpx/s — o mais leve; a escolha certa para upload ruim
  '720p30': {
    name: '720p30',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    warning: null,
  },
  // 55 Mpx/s — mais leve que 1080p30 e com o dobro de quadros
  '720p60': {
    name: '720p60',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 3_500_000,
    warning: null,
  },
  // 62 Mpx/s — padrao
  '1080p30': {
    name: '1080p30',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 4_000_000,
    warning: null,
  },
  // 110 Mpx/s
  '1440p30': {
    name: '1440p30',
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 8_000_000,
    warning: null,
  },
  /**
   * 124 Mpx/s, no teto medido: entrega ~32 de 60 quadros.
   *
   * Bitrate subiu de 6 para 9 Mbps porque a medicao em rede real acusou
   * `gargalo: "bandwidth"` com o kbps grudado no teto de 6 — estava
   * subdimensionado, e abaixo do 1440p30, que tem menos pixels por segundo.
   */
  '1080p60': {
    name: '1080p60',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 9_000_000,
    warning: '~metade dos quadros por software',
  },
  /**
   * 16 Mbps e um EXPERIMENTO, nao um numero calibrado.
   *
   * Medido em rede real contra o LiveKit Cloud, neste preset: bweKbps ~19.700
   * com apenas ~10.200 em uso, gargalo "none", nack 0 — ou seja, sobra o dobro
   * de banda e o fps codificado mesmo assim fica em 32 de 60. Subir o teto
   * separa as duas explicacoes possiveis: se o fps subir, o limite era o
   * bitrate; se ficar em ~32, e o libvpx (software) que nao da conta.
   */
  '1440p60': {
    name: '1440p60',
    width: 2560,
    height: 1440,
    frameRate: 60,
    maxBitrate: 16_000_000,
    warning: '~metade dos quadros por software',
  },
  // 249 Mpx/s — o dobro do teto medido
  '4k30': {
    name: '4k30',
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 20_000_000,
    warning: 'muito pesado por software',
  },
};

/**
 * NAO adicione presets acima de 60 fps.
 *
 * O 1080p120 existiu aqui e foi removido depois de medido: pedindo 120, o
 * `fpsCaptura` volta 60. O capturador de tela do Chromium limita a 60 fps
 * independentemente da constraint, entao o preset so enganava — prometia o
 * dobro e entregava o mesmo, gastando o teto de bitrate maior a toa.
 */
export const MAX_CAPTURE_FRAME_RATE = 60;

/**
 * Padrao em 1080p30, nao 720p30.
 *
 * A resolucao do preset e um teto e `max` nunca faz upscale. Numa tela de
 * 1920x1080 — o caso comum — o 720p30 e o UNICO preset que reduz resolucao,
 * reescalando para 1280x720 com perda visivel; os demais capturam nativo e
 * diferem so em fps e bitrate. Ter o 720p30 como padrao entregava a pior
 * imagem possivel para quem nunca abre o seletor.
 *
 * O 720p30 continua existindo: e a opcao certa para um amigo com upload ruim,
 * onde 2,5 Mbps ja e o limite.
 */
export const DEFAULT_PRESET: QualityPresetName = '1080p30';

// ---------------------------------------------------------------------------
// Contrato HTTP do token-server
// ---------------------------------------------------------------------------

/** POST /api/rooms -> o servidor gera o roomId. O cliente nunca o escolhe. */
export interface CreateRoomResponse {
  roomId: string;
  /** token de PUBLISHER (roomJoin + canPublish + canSubscribe) */
  token: string;
  identity: string;
  livekitUrl: string;
  watchUrl: string;
  expiresAt: number;
}

/** POST /api/rooms/:roomId/viewer-token */
export interface ViewerTokenResponse {
  roomId: string;
  /** token de VIEWER (roomJoin + canSubscribe, SEM canPublish) */
  token: string;
  identity: string;
  livekitUrl: string;
  expiresAt: number;
}

/** POST /api/rooms/:roomId/end — exige o token de PUBLISHER daquela sala. */
export interface EndRoomResponse {
  roomId: string;
  /** false quando a sala ja nao existia no SFU (encerrar duas vezes nao e erro) */
  deleted: boolean;
}

export type ApiErrorCode =
  | 'INVALID_ROOM_ID'
  | 'SERVER_MISCONFIGURED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorResponse {
  error: string;
  code: ApiErrorCode;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'token-server';
  version: string;
  livekitConfigured: boolean;
  livekitUrl: string | null;
  uptimeSeconds: number;
}
