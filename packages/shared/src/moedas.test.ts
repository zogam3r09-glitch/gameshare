import { describe, expect, it } from 'vitest';
import {
  BYTES_POR_MOEDA,
  HORAS_PARA_AVISO,
  avaliarSaldo,
  melhorPresetQueCabe,
  moedasDeBytes,
  moedasPorHoraDeVoz,
  moedasPorHoraEstimadas,
  moedasPorHoraNoTeto,
  projetarHoras,
} from './moedas.js';
import { QUALITY_PRESETS } from './types.js';

describe('cobranca por bytes reais', () => {
  it('1 moeda e 1 MB', () => {
    expect(moedasDeBytes(BYTES_POR_MOEDA)).toBe(1);
    expect(moedasDeBytes(10 * BYTES_POR_MOEDA)).toBe(10);
  });

  /**
   * Contador de bytes so cresce, mas delta entre amostras pode vir negativo
   * numa reconexao, quando o contador zera. Cobrar disso viraria credito.
   */
  it('valor invalido ou negativo nao vira credito', () => {
    expect(moedasDeBytes(-500)).toBe(0);
    expect(moedasDeBytes(Number.NaN)).toBe(0);
    expect(moedasDeBytes(Number.POSITIVE_INFINITY)).toBe(0);
    expect(moedasDeBytes(0)).toBe(0);
  });

  /**
   * O invariante que separa cobranca de projecao: cobranca NAO consulta preset
   * nenhum. Se um dia moedasDeBytes precisar saber a resolucao, a estimativa
   * vazou para dentro do dinheiro.
   */
  it('a cobranca nao depende de resolucao', () => {
    const bytes = 5 * BYTES_POR_MOEDA;
    expect(moedasDeBytes(bytes)).toBe(moedasDeBytes(bytes));
    expect(moedasDeBytes.length).toBe(1);
  });
});

describe('projecao de horas', () => {
  /** Ancora da estimativa: 1080p60 medido a 3,7 Mbps = 1,665 GB/h = 1665 moedas. */
  it('bate com a medicao de 1080p60', () => {
    const m = moedasPorHoraEstimadas(QUALITY_PRESETS['1080p60']);
    expect(m).toBeGreaterThan(1600);
    expect(m).toBeLessThan(1700);
  });

  it('o teto do preset e sempre pior que a estimativa medida', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(
        moedasPorHoraNoTeto(preset),
        `${preset.name}: teto precisa ser o cenario pessimista`,
      ).toBeGreaterThan(moedasPorHoraEstimadas(preset));
    }
  });

  it('mais pixels por segundo custa mais moedas por hora', () => {
    const p720 = moedasPorHoraEstimadas(QUALITY_PRESETS['720p30']);
    const p1080 = moedasPorHoraEstimadas(QUALITY_PRESETS['1080p60']);
    const p1440 = moedasPorHoraEstimadas(QUALITY_PRESETS['1440p60']);
    expect(p720).toBeLessThan(p1080);
    expect(p1080).toBeLessThan(p1440);
  });

  it('a tela de saldo cobre todos os presets e mostra a faixa', () => {
    const linhas = projetarHoras(33_500);
    expect(linhas).toHaveLength(Object.keys(QUALITY_PRESETS).length);
    for (const l of linhas) {
      expect(l.horasNoTeto, `${l.preset}: o pior caso da menos horas`).toBeLessThan(l.horas);
    }
  });

  /** Voz e ordem de grandeza abaixo do video: e o que permite call sem limite proprio. */
  it('voz custa uma fracao do video mais barato', () => {
    const voz = moedasPorHoraDeVoz(2);
    const maisBarato = moedasPorHoraEstimadas(QUALITY_PRESETS['720p30']);
    expect(voz).toBeLessThan(maisBarato / 5);
  });
});

describe('degradacao em vez de corte', () => {
  const permitidos = ['720p30', '900p60', '1080p60'] as const;

  it('saldo alto escolhe o melhor preset permitido', () => {
    expect(melhorPresetQueCabe(500_000, 2, [...permitidos])).toBe('1080p60');
  });

  /**
   * O comportamento que importa: sobrando pouco, o usuario cai de qualidade e
   * continua assistindo, em vez de levar uma tela de "acabou".
   */
  it('saldo apertado desce de qualidade em vez de devolver nada', () => {
    const saldo = moedasPorHoraNoTeto(QUALITY_PRESETS['720p30']) * 3;
    expect(melhorPresetQueCabe(saldo, 2, [...permitidos])).toBe('720p30');
  });

  it('sem saldo para nenhum preset, devolve null', () => {
    expect(melhorPresetQueCabe(1, 2, [...permitidos])).toBeNull();
  });

  it('nunca escolhe fora da lista de permitidos do plano', () => {
    const escolhido = melhorPresetQueCabe(10_000_000, 2, ['720p30', '900p60']);
    expect(escolhido).not.toBe('1080p60');
    expect(escolhido).toBe('900p60');
  });
});

describe('aviso de saldo', () => {
  it('avisa antes de acabar, nao depois', () => {
    const preset = QUALITY_PRESETS['1080p60'];
    const porHora = moedasPorHoraNoTeto(preset);
    expect(avaliarSaldo(porHora * (HORAS_PARA_AVISO - 0.5), preset).avisar).toBe(true);
    expect(avaliarSaldo(porHora * (HORAS_PARA_AVISO + 1), preset).avisar).toBe(false);
  });

  it('saldo zerado e esgotado', () => {
    expect(avaliarSaldo(0, QUALITY_PRESETS['1080p60']).esgotado).toBe(true);
    expect(avaliarSaldo(100, QUALITY_PRESETS['1080p60']).esgotado).toBe(false);
  });
});
