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
  | '900p30'
  | '720p60'
  | '900p60'
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
}

/**
 * NAO existe um teto fixo de fps de captura por resolucao. Ja existiu aqui uma
 * constante OBSERVED_CAPTURE_PIXELS_PER_SECOND = 124 Mpx/s, e ela estava
 * errada por dois motivos:
 *
 * 1. O numero nao se repete. Mesma maquina, mesma tela, mesmo 1080p60: uma
 *    sessao mediu fpsFonte 32 estavel; outra mediu 58, 58, 58, 41. O
 *    capturador do Windows entrega quadro quando a tela MUDA, entao o fps da
 *    fonte segue o conteudo, nao a capacidade do hardware. Tela parada rende
 *    poucos quadros e isso nao e gargalo nenhum.
 *
 * 2. Mesmo se fosse estavel, medir pela resolucao do PRESET seria errado. A
 *    resolucao do preset e teto e `max` nunca faz upscale: numa tela 1080p,
 *    4k30 captura 1920x1080 igual ao 1080p30. A carga real sai da tela do
 *    usuario, que este pacote nao conhece.
 *
 * Por isso os presets nao tem mais campo `warning`: qualquer aviso aqui seria
 * um palpite sobre a maquina de quem esta lendo. O painel AO VIVO mostra
 * fpsFonte, fpsCodificado e `gargalo` reais - esse e o lugar de diagnosticar.
 *
 * MAX_CAPTURE_FRAME_RATE abaixo continua valendo: aquele foi medido e se
 * repete, porque e um limite do Chromium, nao do conteudo.
 */
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
  },
  // 43 Mpx/s — meio-termo entre 720p e 1080p, util em upload apertado
  '900p30': {
    name: '900p30',
    width: 1600,
    height: 900,
    frameRate: 30,
    maxBitrate: 3_000_000,
  },
  // 55 Mpx/s — mais leve que 1080p30 e com o dobro de quadros
  '720p60': {
    name: '720p60',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 3_500_000,
  },
  // 62 Mpx/s — padrao
  '1080p30': {
    name: '1080p30',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 4_000_000,
  },
  // 86 Mpx/s — 60 fps por 2/3 do bitrate do 1080p60
  '900p60': {
    name: '900p60',
    width: 1600,
    height: 900,
    frameRate: 60,
    maxBitrate: 6_000_000,
  },
  // 110 Mpx/s
  '1440p30': {
    name: '1440p30',
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 8_000_000,
  },
  /**
   * 124 Mpx/s.
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
  },
  /**
   * 16 Mbps e um EXPERIMENTO, nao um numero calibrado.
   *
   * Medido em rede real contra o LiveKit Cloud, neste preset: bweKbps ~19.700
   * com apenas ~10.200 em uso, gargalo "none", nack 0 — sobra o dobro de banda
   * e o fps codificado ficou em 32 de 60 naquela sessao. Ficou subindo o teto
   * para separar as explicacoes; a resposta veio de outro lado (o fps da fonte
   * segue o conteudo da tela, ver comentario acima dos presets), entao 16 Mbps
   * continua sendo um chute generoso, nao uma calibracao.
   */
  '1440p60': {
    name: '1440p60',
    width: 2560,
    height: 1440,
    frameRate: 60,
    maxBitrate: 16_000_000,
  },
  // 249 Mpx/s — so faz diferenca em tela 4K; abaixo disso e 1080p30 com teto
  // de bitrate folgado, ja que a resolucao do preset nunca faz upscale
  '4k30': {
    name: '4k30',
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 20_000_000,
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
  /** a sala existiu e o streamer ja encerrou */
  | 'ROOM_ENDED'
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
