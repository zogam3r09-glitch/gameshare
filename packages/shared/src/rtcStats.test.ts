import { describe, expect, it } from 'vitest';
import { kbpsEntreAmostras, lerAmostra, lerAmostraEntrada } from './rtcStats.js';

/** RTCStatsReport e um Map; para ler basta um Map de verdade. */
const relatorio = (...entradas: Record<string, unknown>[]): RTCStatsReport =>
  new Map(entradas.map((e, i) => [String(i), e])) as unknown as RTCStatsReport;

const outbound = (extra: Record<string, unknown> = {}) => ({
  type: 'outbound-rtp',
  kind: 'video',
  ...extra,
});

const inbound = (extra: Record<string, unknown> = {}) => ({
  type: 'inbound-rtp',
  kind: 'video',
  ...extra,
});

describe('lerAmostra (envio)', () => {
  it('relatorio vazio nao inventa numero', () => {
    const a = lerAmostra(relatorio());
    expect(a.encodedFps).toBeNull();
    expect(a.sourceFps).toBeNull();
    expect(a.rttMs).toBeNull();
  });

  it('le fps, encoder e resolucao codificada', () => {
    const a = lerAmostra(
      relatorio(
        outbound({
          framesPerSecond: 32.4,
          encoderImplementation: 'libvpx',
          frameWidth: 1920,
          frameHeight: 1080,
          qualityLimitationReason: 'none',
        }),
      ),
    );
    expect(a.encodedFps).toBe(32);
    expect(a.encoder).toBe('libvpx');
    expect(a.encodedWidth).toBe(1920);
    expect(a.limitedBy).toBe('none');
  });

  it('ignora outbound-rtp de audio', () => {
    expect(
      lerAmostra(relatorio({ type: 'outbound-rtp', kind: 'audio', framesPerSecond: 50 })).encodedFps,
    ).toBeNull();
  });

  /**
   * Regressao central da investigacao de performance: o fps "da captura" vinha
   * de getSettings(), que devolve o valor PEDIDO. Isso levou a atribuir a CPU
   * um limite que era da captura. A fonte correta e media-source.
   */
  it('separa o fps da FONTE do fps do encoder', () => {
    const a = lerAmostra(
      relatorio(outbound({ framesPerSecond: 32 }), {
        type: 'media-source',
        kind: 'video',
        framesPerSecond: 60,
        framesDropped: 7,
      }),
    );
    expect(a.sourceFps).toBe(60);
    expect(a.encodedFps).toBe(32);
    expect(a.framesDropped).toBe(7);
  });

  it('soma bytesSent de varias camadas (simulcast)', () => {
    expect(
      lerAmostra(relatorio(outbound({ bytesSent: 1000 }), outbound({ bytesSent: 250 })))
        .videoBytesSent,
    ).toBe(1250);
  });

  it('duracoes acumuladas revelam o que o reason instantaneo esconde', () => {
    const a = lerAmostra(
      relatorio(
        outbound({
          qualityLimitationReason: 'none',
          qualityLimitationDurations: { cpu: 12.7, bandwidth: 0, none: 300 },
        }),
      ),
    );
    expect(a.limitedBy).toBe('none');
    expect(a.limitedByCpuSeconds).toBe(13);
  });

  it('BWE e RTT vem do par ICE nomeado e bem-sucedido', () => {
    const a = lerAmostra(
      relatorio({
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        availableOutgoingBitrate: 19_654_000,
        currentRoundTripTime: 0.0134,
      }),
    );
    expect(a.availableKbps).toBe(19654);
    expect(a.rttMs).toBe(13);
  });

  it('ignora par ICE nao nomeado ou que falhou', () => {
    const a = lerAmostra(
      relatorio(
        { type: 'candidate-pair', state: 'succeeded', nominated: false, currentRoundTripTime: 9 },
        { type: 'candidate-pair', state: 'failed', nominated: true, currentRoundTripTime: 9 },
      ),
    );
    expect(a.rttMs).toBeNull();
  });
});

describe('lerAmostraEntrada (recepcao)', () => {
  it('le fps, congelamentos e perda', () => {
    const a = lerAmostraEntrada(
      relatorio(
        inbound({
          framesPerSecond: 30,
          freezeCount: 2,
          totalFreezesDuration: 1.5,
          packetsLost: 11,
          decoderImplementation: 'libvpx',
        }),
      ),
    );
    expect(a.fps).toBe(30);
    expect(a.freezeCount).toBe(2);
    expect(a.freezeMs).toBe(1500);
    expect(a.packetsLost).toBe(11);
    expect(a.decoder).toBe('libvpx');
  });

  /**
   * jitterBufferDelay e acumulado. Sem dividir pelo contador de quadros, o
   * numero cresce para sempre e pareceria uma degradacao que nao existe.
   */
  it('jitter buffer e a MEDIA por quadro, nao o acumulado', () => {
    const a = lerAmostraEntrada(
      relatorio(inbound({ jitterBufferDelay: 4.5, jitterBufferEmittedCount: 600 })),
    );
    expect(a.jitterBufferMs).toBe(8);
  });

  it('sem quadros emitidos nao divide por zero', () => {
    const a = lerAmostraEntrada(
      relatorio(inbound({ jitterBufferDelay: 4.5, jitterBufferEmittedCount: 0 })),
    );
    expect(a.jitterBufferMs).toBeNull();
  });

  it('ignora inbound-rtp de audio', () => {
    expect(
      lerAmostraEntrada(relatorio({ type: 'inbound-rtp', kind: 'audio', framesPerSecond: 50 })).fps,
    ).toBeNull();
  });
});

describe('kbpsEntreAmostras', () => {
  it('primeira amostra nao produz taxa', () => {
    expect(kbpsEntreAmostras(null, { bytes: 1000, at: 100 })).toBeNull();
  });

  it('calcula kbps pelo delta', () => {
    // 125.000 bytes em 1s = 1.000.000 bits/s = 1000 kbps
    expect(kbpsEntreAmostras({ bytes: 0, at: 0 }, { bytes: 125_000, at: 1000 })).toBe(1000);
  });

  /** O acumulado zera quando a conexao e refeita; sem guarda daria negativo. */
  it('contador que regrediu devolve null', () => {
    expect(kbpsEntreAmostras({ bytes: 500_000, at: 0 }, { bytes: 1000, at: 1000 })).toBeNull();
  });

  it('relogio parado devolve null em vez de dividir por zero', () => {
    expect(kbpsEntreAmostras({ bytes: 0, at: 500 }, { bytes: 1000, at: 500 })).toBeNull();
  });
});
