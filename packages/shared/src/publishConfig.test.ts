import { describe, expect, it } from 'vitest';
import {
  ROOM_OPTIONS,
  SCREEN_SHARE_SIMULCAST,
  screenShareOptions,
  SCREEN_AUDIO_OPTIONS,
} from './publishConfig.js';
import { DEFAULT_PRESET, QUALITY_PRESETS } from './types.js';

describe('configuracao de publicacao', () => {
  /**
   * O invariante que custou caro, e o motivo real de o bug existir: dynacast
   * serve para parar de codificar CAMADAS que ninguem assina. Com simulcast
   * desligado existe uma camada so, entao ele nao tem o que gerenciar e a
   * unica coisa que faz e pausar o encoder com a sala vazia.
   *
   * O preco disso nao e economia: a estimativa de banda apodrece ate ~5 kbps
   * sem nada sendo enviado, e o primeiro espectador religa o encoder a partir
   * desse chao. Medido, 24s subindo de 320x180 ate 1920x1080.
   *
   * Se alguem religar simulcast um dia, dynacast volta a fazer sentido e este
   * teste para de exigir que ele fique desligado.
   */
  it('com simulcast desligado, dynacast tambem tem que estar', () => {
    if (SCREEN_SHARE_SIMULCAST === false) {
      expect(ROOM_OPTIONS.dynacast).toBe(false);
    }
  });

  /**
   * Regressao cara de achar: para source ScreenShare o livekit-client le
   * `screenShareEncoding` e ignora `videoEncoding` em silencio, caindo em
   * ScreenSharePresets.h1080fps15 — teto de 15 FPS, sem erro nenhum.
   */
  it('o encoding sai do preset, nao de um valor chumbado', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      const opts = screenShareOptions(preset);
      expect(opts.screenShareEncoding.maxFramerate, preset.name).toBe(preset.frameRate);
      expect(opts.screenShareEncoding.maxBitrate, preset.name).toBe(preset.maxBitrate);
    }
  });

  it('mantem framerate em vez de nitidez, que e o certo para jogo', () => {
    const opts = screenShareOptions(QUALITY_PRESETS[DEFAULT_PRESET]);
    expect(opts.degradationPreference).toBe('maintain-framerate');
  });

  /** Audio de jogo e continuo: DTX cortaria trechos e RED gastaria banda. */
  it('o audio do sistema vai sem DTX, sem RED e em estereo', () => {
    expect(SCREEN_AUDIO_OPTIONS).toMatchObject({ dtx: false, red: false, forceStereo: true });
  });
});
