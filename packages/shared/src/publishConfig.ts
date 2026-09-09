/**
 * Configuracao de publicacao, compartilhada entre o app e o publisher
 * sintetico do e2e.
 *
 * Por que ela mora aqui e nao no desktop: o teste e2e publica com um publisher
 * proprio, e ele estava com a configuracao escrita a mao. Ou seja, o e2e
 * exercitava um publisher DIFERENTE do que o app envia para o usuario, e
 * qualquer divergencia era invisivel.
 *
 * Foi exatamente onde passou o bug do dynacast: o app publicava com
 * `dynacast: true` e o teste com `new Room()` (padrao), entao nenhum teste
 * podia ter pego os 24s de 320x180 que o primeiro espectador via.
 *
 * Sao objetos JSON puros de proposito. Assim o Playwright consegue passa-los
 * para dentro de `page.evaluate`, e este pacote nao precisa depender do
 * livekit-client — o que importaria SDK de cliente no token-server.
 */

import type { QualityPreset } from './types.js';

/**
 * `as const` e obrigatorio: sem ele o TypeScript alarga
 * 'maintain-framerate' para string e o publishTrack recusa.
 */
export const ROOM_OPTIONS = {
  /** publisher nao precisa; reduz variacao de latencia */
  adaptiveStream: false,
  /**
   * DESLIGADO de proposito. Ver o comentario extenso em broadcast.ts: com
   * simulcast false existe uma camada so, entao o dynacast nao tem o que
   * gerenciar e apenas pausa o encoder com a sala vazia. A estimativa de banda
   * apodrecia ate ~5 kbps e o primeiro espectador pegava 24s de rampa a partir
   * de 320x180.
   */
  dynacast: false,
  disconnectOnPageLeave: true,
} as const;

/** POC: uma camada so, menos CPU e menos latencia. */
export const SCREEN_SHARE_SIMULCAST = false;

/**
 * Codecs que o livekit-client aceita para video.
 *
 * vp8 e o padrao e o unico medido ate agora: `encoderImplementation` volta
 * "libvpx", ou seja software puro. h264 e o candidato a engatar aceleracao por
 * hardware no Windows (MediaFoundation/AMF); vp9 e av1 economizam bits mas
 * custam CPU. Trocar aqui e o experimento que responde se da para transmitir
 * sem roubar FPS do jogo.
 */
export type VideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1';

export const DEFAULT_VIDEO_CODEC: VideoCodec = 'vp8';

/**
 * `screenShareEncoding`, NAO `videoEncoding`: para source ScreenShare o
 * livekit-client le exclusivamente o primeiro e ignora o segundo em silencio,
 * caindo no padrao ScreenSharePresets.h1080fps15 — um teto de 15 FPS.
 */
export function screenShareOptions(preset: QualityPreset, codec: VideoCodec = DEFAULT_VIDEO_CODEC) {
  return {
    name: 'screen',
    simulcast: SCREEN_SHARE_SIMULCAST,
    screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate },
    /** jogo: preferimos fps a nitidez */
    degradationPreference: 'maintain-framerate',
    videoCodec: codec,
  } as const;
}

/** Audio de jogo e continuo; DTX cortaria trechos. */
export const SCREEN_AUDIO_OPTIONS = {
  name: 'system-audio',
  dtx: false,
  red: false,
  forceStereo: true,
} as const;
