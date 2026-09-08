/**
 * Leitura do RTCStatsReport. Vive aqui, e nao dentro de um dos apps, porque os
 * DOIS lados leem estatisticas: o desktop as de envio (outbound-rtp) e o
 * viewer as de recepcao (inbound-rtp). Antes disso existia parsing parecido
 * duplicado nos dois.
 *
 * Isto ja foi fonte de varios diagnosticos errados — um campo lido do lugar
 * errado manda a investigacao inteira para o lado oposto. Os casos que
 * custaram mais tempo estao marcados no codigo. Como funcao pura sobre um
 * RTCStatsReport, da para cobrir com teste sem Electron, LiveKit ou navegador.
 */

export interface RtcSample {
  /** fps que o encoder de fato produz (outbound-rtp) */
  encodedFps: number | null;
  /** fps que a CAPTURA produz (media-source). Ver aviso em `capturedFps`. */
  sourceFps: number | null;
  /** bytes acumulados; virar kbps exige duas amostras, ver `kbpsEntreAmostras` */
  videoBytesSent: number | null;
  encoder: string | null;
  limitedBy: string | null;
  framesDropped: number | null;
  availableKbps: number | null;
  rttMs: number | null;
  nack: number | null;
  pli: number | null;
  /** resolucao REALMENTE codificada, que pode ser menor que a capturada */
  encodedWidth: number | null;
  encodedHeight: number | null;
  limitedByCpuSeconds: number | null;
  limitedByBandwidthSeconds: number | null;
}

export const AMOSTRA_VAZIA: RtcSample = {
  encodedFps: null,
  sourceFps: null,
  videoBytesSent: null,
  encoder: null,
  limitedBy: null,
  framesDropped: null,
  availableKbps: null,
  rttMs: null,
  nack: null,
  pli: null,
  encodedWidth: null,
  encodedHeight: null,
  limitedByCpuSeconds: null,
  limitedByBandwidthSeconds: null,
};

type Bruto = RTCStats & Record<string, unknown>;

const numero = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function lerAmostra(report: RTCStatsReport): RtcSample {
  const out: RtcSample = { ...AMOSTRA_VAZIA };

  report.forEach((entry) => {
    const s = entry as Bruto;

    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      const fps = numero(s.framesPerSecond);
      if (fps !== null) out.encodedFps = Math.round(fps);

      // somado: com simulcast haveria uma entrada por camada
      const bytes = numero(s.bytesSent);
      if (bytes !== null) out.videoBytesSent = (out.videoBytesSent ?? 0) + bytes;

      out.encoder = texto(s.encoderImplementation) ?? out.encoder;
      out.limitedBy = texto(s.qualityLimitationReason) ?? out.limitedBy;
      out.nack = numero(s.nackCount) ?? out.nack;
      out.pli = numero(s.pliCount) ?? out.pli;
      out.encodedWidth = numero(s.frameWidth) ?? out.encodedWidth;
      out.encodedHeight = numero(s.frameHeight) ?? out.encodedHeight;

      /**
       * Acumulado por motivo, ao contrario de qualityLimitationReason, que e
       * instantaneo e ja reportou "none" durante problemas reais. Foi este
       * campo que provou que o teto de 32 fps NAO era CPU.
       */
      const dur = s.qualityLimitationDurations as Record<string, number> | undefined;
      if (dur) {
        const cpu = numero(dur.cpu);
        const banda = numero(dur.bandwidth);
        if (cpu !== null) out.limitedByCpuSeconds = Math.round(cpu);
        if (banda !== null) out.limitedByBandwidthSeconds = Math.round(banda);
      }
      return;
    }

    /**
     * A FONTE. `getSettings().frameRate` NAO serve aqui: devolve o valor
     * pedido, nao o entregue — sempre diria 60 mesmo com a captura em 32.
     * Confundir os dois ja fez atribuir a CPU um limite que era da captura.
     */
    if (s.type === 'media-source' && s.kind === 'video') {
      out.framesDropped = numero(s.framesDropped) ?? out.framesDropped;
      const fps = numero(s.framesPerSecond);
      if (fps !== null) out.sourceFps = Math.round(fps);
      return;
    }

    // Par ICE em uso: onde vivem a estimativa de banda e o RTT confiavel.
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated === true) {
      const bwe = numero(s.availableOutgoingBitrate);
      if (bwe !== null) out.availableKbps = Math.round(bwe / 1000);
      const rtt = numero(s.currentRoundTripTime);
      if (rtt !== null) out.rttMs = Math.round(rtt * 1000);
    }
  });

  return out;
}

/** Metricas de quem RECEBE (viewer). */
export interface RtcSampleEntrada {
  fps: number | null;
  /** atraso medio do jitter buffer em ms — principal suspeito de "lag" */
  jitterBufferMs: number | null;
  freezeCount: number | null;
  freezeMs: number | null;
  packetsLost: number | null;
  decoder: string | null;
}

export const AMOSTRA_ENTRADA_VAZIA: RtcSampleEntrada = {
  fps: null,
  jitterBufferMs: null,
  freezeCount: null,
  freezeMs: null,
  packetsLost: null,
  decoder: null,
};

export function lerAmostraEntrada(report: RTCStatsReport): RtcSampleEntrada {
  const out: RtcSampleEntrada = { ...AMOSTRA_ENTRADA_VAZIA };

  report.forEach((entry) => {
    const s = entry as Bruto;
    if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;

    const fps = numero(s.framesPerSecond);
    if (fps !== null) out.fps = Math.round(fps);

    /**
     * jitterBufferDelay e ACUMULADO em segundos; sozinho nao significa nada.
     * A media por quadro exige dividir por jitterBufferEmittedCount — sem essa
     * divisao o numero cresce para sempre e parece uma degradacao que nao ha.
     */
    const atraso = numero(s.jitterBufferDelay);
    const quadros = numero(s.jitterBufferEmittedCount);
    if (atraso !== null && quadros !== null && quadros > 0) {
      out.jitterBufferMs = Math.round((atraso / quadros) * 1000);
    }

    out.freezeCount = numero(s.freezeCount) ?? out.freezeCount;
    const congelado = numero(s.totalFreezesDuration);
    if (congelado !== null) out.freezeMs = Math.round(congelado * 1000);
    out.packetsLost = numero(s.packetsLost) ?? out.packetsLost;
    out.decoder = texto(s.decoderImplementation) ?? out.decoder;
  });

  return out;
}

export interface MarcaBytes {
  bytes: number;
  at: number;
}

/**
 * kbps a partir de duas amostras. Null quando nao da para calcular ainda —
 * primeira amostra, relogio que nao avancou, ou contador que regrediu
 * (acontece quando a conexao e refeita e o acumulado zera).
 */
export function kbpsEntreAmostras(anterior: MarcaBytes | null, atual: MarcaBytes): number | null {
  if (!anterior) return null;
  const ms = atual.at - anterior.at;
  const bytes = atual.bytes - anterior.bytes;
  if (ms <= 0 || bytes < 0) return null;
  return Math.round((bytes * 8) / ms);
}
