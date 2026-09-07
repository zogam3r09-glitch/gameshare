/** Fonte de captura exposta pelo main process do Electron ao renderer. */
export interface CaptureSource {
  /** id opaco do desktopCapturer (`screen:0:0`, `window:1234:0`) */
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** data: URL PNG do preview (pode ser string vazia se o preview falhar) */
  thumbnailDataUrl: string;
}

/** Preset de qualidade. V0.1 usa apenas `720p30`; os demais ficam prontos. */
export type QualityPresetName = '720p30' | '1080p30' | '1080p60' | '1440p60';

export interface QualityPreset {
  name: QualityPresetName;
  width: number;
  height: number;
  frameRate: number;
  /** bitrate maximo de video em bits/s */
  maxBitrate: number;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  '720p30': { name: '720p30', width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  '1080p30': { name: '1080p30', width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_000_000 },
  '1080p60': { name: '1080p60', width: 1920, height: 1080, frameRate: 60, maxBitrate: 6_000_000 },
  '1440p60': { name: '1440p60', width: 2560, height: 1440, frameRate: 60, maxBitrate: 10_000_000 },
};

export const DEFAULT_PRESET: QualityPresetName = '720p30';

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
