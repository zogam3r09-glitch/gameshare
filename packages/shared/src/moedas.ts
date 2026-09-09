/**
 * Moeda do produto: cobranca e projecao de consumo.
 *
 * A REGRA QUE SEPARA AS DUAS COISAS, e que e o ponto inteiro deste arquivo:
 *
 *   COBRANCA usa bytes REALMENTE transmitidos. Exata, sem estimativa.
 *   PROJECAO usa estimativa de bitrate. Aproximada, so para a UI dizer
 *   "seu saldo da mais ou menos X horas".
 *
 * Isso importa porque toda a estimativa de bitrate deste projeto vem de UMA
 * medicao, feita em tela de desktop. Se jogo consumir o dobro, uma cobranca
 * baseada em estimativa erraria o dobro — em dinheiro. Baseada em bytes reais,
 * o unico efeito e a projecao da UI ficar otimista, e o usuario receber menos
 * horas do que o painel prometeu. Chato, mas nao e prejuizo nem cobranca
 * indevida.
 */

import { QUALITY_PRESETS, type QualityPreset, type QualityPresetName } from './types.js';

/**
 * 1 moeda = 1 MB de saida. Ancorar em bytes, e nao em minutos, mantem a margem
 * por moeda fixa: se um jogo pesado gastar o dobro de bits, quem recebe menos
 * horas e o usuario, e nao a operacao que absorve custo.
 */
export const BYTES_POR_MOEDA = 1_000_000;

/** Quanto custa, em moedas, um volume ja transmitido. Esta e a cobranca. */
export function moedasDeBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / BYTES_POR_MOEDA;
}

/**
 * Taxa medida: 1080p60 entregou 3,7 Mbps sobre 124,4 Mpx/s de conteudo de
 * desktop, ou seja 0,0297 bits por pixel-segundo.
 *
 * E UMA medicao, de conteudo quase parado. Jogo com movimento tende a subir, e
 * o teto configurado de cada preset e bem mais alto. Serve para projetar horas
 * na tela de saldo — nunca para cobrar.
 */
export const BITS_POR_PIXEL_SEGUNDO = 0.0297;

/** Audio de voz em Opus. Sobe pouco e quase nao muda com o conteudo. */
export const VOZ_KBPS = 48;

/** Estimativa de moedas por hora recebendo um preset. Projecao, nao cobranca. */
export function moedasPorHoraEstimadas(preset: QualityPreset): number {
  const bitsPorSegundo = preset.width * preset.height * preset.frameRate * BITS_POR_PIXEL_SEGUNDO;
  return (bitsPorSegundo * 3600) / 8 / BYTES_POR_MOEDA;
}

/**
 * Teto de moedas por hora, se o encoder encostar no limite do preset.
 *
 * A projecao honesta e uma faixa, nao um numero: a tela de saldo deveria dizer
 * "20 a 48 horas", nao "20 horas", enquanto o consumo em jogo nao for medido.
 */
export function moedasPorHoraNoTeto(preset: QualityPreset): number {
  return (preset.maxBitrate * 3600) / 8 / BYTES_POR_MOEDA;
}

/** Voz custa por fluxo recebido; numa call cada um recebe quem esta falando. */
export function moedasPorHoraDeVoz(fluxosRecebidos = 2): number {
  return (VOZ_KBPS * 1000 * fluxosRecebidos * 3600) / 8 / BYTES_POR_MOEDA;
}

export interface ProjecaoDeHoras {
  preset: QualityPresetName;
  /** cenario da medicao atual */
  horas: number;
  /** cenario pessimista: encoder no teto do preset */
  horasNoTeto: number;
}

/** O que a tela de saldo mostra: quanto dura, em cada resolucao. */
export function projetarHoras(saldo: number): ProjecaoDeHoras[] {
  return Object.values(QUALITY_PRESETS).map((preset) => ({
    preset: preset.name,
    horas: saldo / moedasPorHoraEstimadas(preset),
    horasNoTeto: saldo / moedasPorHoraNoTeto(preset),
  }));
}

/**
 * Preset mais alto que cabe no saldo por pelo menos `horasMinimas`.
 *
 * Serve para a degradacao ao inves do corte: acabando o saldo o usuario cai
 * de qualidade e continua dentro do produto, em vez de levar uma tela de
 * "acabou". Usa o teto do preset de proposito — para degradar, o pessimista e
 * o certo, senao prometemos horas que o jogo nao vai entregar.
 */
export function melhorPresetQueCabe(
  saldo: number,
  horasMinimas: number,
  permitidos: QualityPresetName[],
): QualityPresetName | null {
  let escolhido: QualityPresetName | null = null;
  let melhorCarga = -1;

  for (const nome of permitidos) {
    const preset = QUALITY_PRESETS[nome];
    if (!preset) continue;
    if (saldo / moedasPorHoraNoTeto(preset) < horasMinimas) continue;

    const carga = preset.width * preset.height * preset.frameRate;
    if (carga > melhorCarga) {
      melhorCarga = carga;
      escolhido = nome;
    }
  }
  return escolhido;
}

export interface EstadoDeSaldo {
  saldo: number;
  /** true quando ja da para avisar que esta perto do fim */
  avisar: boolean;
  esgotado: boolean;
}

/** Abaixo disto a UI avisa que o saldo esta acabando. */
export const HORAS_PARA_AVISO = 2;

export function avaliarSaldo(saldo: number, preset: QualityPreset): EstadoDeSaldo {
  const horas = saldo / moedasPorHoraNoTeto(preset);
  return { saldo, avisar: horas < HORAS_PARA_AVISO, esgotado: saldo <= 0 };
}
