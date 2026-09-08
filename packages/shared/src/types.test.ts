import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET,
  MAX_CAPTURE_FRAME_RATE,
  QUALITY_PRESETS,
  pixelsPerSecond,
  type QualityPresetName,
} from './types.js';

const presets = Object.entries(QUALITY_PRESETS) as [QualityPresetName, (typeof QUALITY_PRESETS)[QualityPresetName]][];

describe('presets de qualidade', () => {
  it('a chave do mapa bate com o campo name', () => {
    for (const [key, preset] of presets) expect(preset.name).toBe(key);
  });

  it('todos tem dimensoes e framerate positivos', () => {
    for (const [, p] of presets) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(p.frameRate).toBeGreaterThan(0);
      expect(p.maxBitrate).toBeGreaterThan(0);
    }
  });

  it('o nome descreve a altura e o framerate reais', () => {
    for (const [, p] of presets) {
      expect(p.name).toContain(String(p.frameRate));
      // 4k30 e o unico rotulado pela largura, nao pela altura
      if (!p.name.startsWith('4k')) expect(p.name).toContain(String(p.height));
    }
  });

  /**
   * Ordenar por pixels/s e exigir bitrate crescente seria falso: 4k30 e
   * 1080p120 tem exatamente os mesmos 248,8 Mpx/s, e ainda assim o 4K precisa
   * de mais bits, porque bitrate acompanha detalhe espacial, nao so
   * throughput. A checagem util e a densidade ficar numa faixa sensata — foi
   * assim que apareceu o 1080p60 subdimensionado a 6 Mbps.
   */
  it('bits por pixel-segundo ficam numa faixa sensata', () => {
    for (const [, p] of presets) {
      const bitsPorPixel = p.maxBitrate / pixelsPerSecond(p);
      expect(bitsPorPixel, `${p.name}: ${bitsPorPixel.toFixed(4)} bits/px`).toBeGreaterThan(0.04);
      expect(bitsPorPixel, `${p.name}: ${bitsPorPixel.toFixed(4)} bits/px`).toBeLessThan(0.1);
    }
  });

  /**
   * Medido: pedindo 120 fps, o capturador do Chromium devolve 60. Um preset
   * acima disso promete o dobro, entrega o mesmo e ainda reserva bitrate a toa.
   */
  it('nenhum preset pede mais quadros do que a captura entrega', () => {
    for (const [, p] of presets) {
      expect(p.frameRate, p.name).toBeLessThanOrEqual(MAX_CAPTURE_FRAME_RATE);
    }
  });

  /**
   * A ordem do mapa e a ordem do seletor, e ela sobe por pixels por segundo —
   * cada entrada tem o seu valor no comentario. Um preset inserido no lugar
   * errado nao quebra nada tecnicamente, mas deixa a lista fora de ordem para
   * quem escolhe. `<=` e nao `<` porque dois presets podem legitimamente ter
   * a mesma carga (4k30 e 1080p120 tinham 248,8 Mpx/s identicos).
   */
  it('o seletor sobe em pixels por segundo', () => {
    const cargas = presets.map(([, p]) => pixelsPerSecond(p));
    for (let i = 1; i < cargas.length; i++) {
      expect(cargas[i]!, `${presets[i]![0]} vem depois de ${presets[i - 1]![0]}`).toBeGreaterThanOrEqual(
        cargas[i - 1]!,
      );
    }
  });

  /**
   * Regressao do bug de qualidade: o padrao era 720p30, o unico preset que
   * reduz resolucao numa tela 1080p, entao quem nunca abria o seletor recebia
   * a pior imagem possivel.
   */
  it('o padrao captura 1080p nativo, sem downscale', () => {
    const d = QUALITY_PRESETS[DEFAULT_PRESET];
    expect(d.width).toBeGreaterThanOrEqual(1920);
    expect(d.height).toBeGreaterThanOrEqual(1080);
  });
});
