import { describe, expect, it } from 'vitest';
import { RoomRegistry } from './rooms.js';

/** Relogio controlado: expiracao testada sem esperar horas. */
function comRelogio(inicio = 1_000_000): { agora: () => number; avancar: (ms: number) => void } {
  let t = inicio;
  return { agora: () => t, avancar: (ms) => (t += ms) };
}

describe('RoomRegistry', () => {
  it('lembra uma sala criada e ela comeca sem encerramento', () => {
    const r = new RoomRegistry();
    r.create('ABCD-EFGH');
    expect(r.get('ABCD-EFGH')?.endedAt).toBeNull();
  });

  it('sala nunca criada e desconhecida', () => {
    expect(new RoomRegistry().get('ZZZZ-2222')).toBeNull();
  });

  it('markEnded marca o horario', () => {
    const c = comRelogio();
    const r = new RoomRegistry({ now: c.agora });
    r.create('ABCD-EFGH');
    c.avancar(5000);
    r.markEnded('ABCD-EFGH');
    expect(r.get('ABCD-EFGH')?.endedAt).toBe(1_005_000);
  });

  it('encerrar duas vezes nao move o horario', () => {
    const c = comRelogio();
    const r = new RoomRegistry({ now: c.agora });
    r.create('ABCD-EFGH');
    r.markEnded('ABCD-EFGH');
    const primeiro = r.get('ABCD-EFGH')?.endedAt;
    c.avancar(60_000);
    r.markEnded('ABCD-EFGH');
    expect(r.get('ABCD-EFGH')?.endedAt).toBe(primeiro);
  });

  it('encerrar sala desconhecida nao explode', () => {
    expect(() => new RoomRegistry().markEnded('ZZZZ-2222')).not.toThrow();
  });

  it('esquece a sala encerrada depois da janela de memoria', () => {
    const c = comRelogio();
    const r = new RoomRegistry({ now: c.agora, rememberEndedMs: 10_000 });
    r.create('ABCD-EFGH');
    r.markEnded('ABCD-EFGH');

    c.avancar(9_000);
    expect(r.get('ABCD-EFGH')).not.toBeNull();

    c.avancar(2_000);
    expect(r.get('ABCD-EFGH')).toBeNull();
  });

  /**
   * Uma transmissao pode ficar horas no ar sem ninguem chamar /end - o streamer
   * fecha o app na marra, por exemplo. Sem o teto de idade, essas salas
   * ficariam na memoria para sempre.
   */
  it('esquece sala antiga mesmo sem encerramento explicito', () => {
    const c = comRelogio();
    const r = new RoomRegistry({ now: c.agora, maxAgeMs: 60_000 });
    r.create('ABCD-EFGH');

    c.avancar(59_000);
    expect(r.get('ABCD-EFGH')).not.toBeNull();

    c.avancar(2_000);
    expect(r.get('ABCD-EFGH')).toBeNull();
  });

  it('size reflete a limpeza', () => {
    const c = comRelogio();
    const r = new RoomRegistry({ now: c.agora, maxAgeMs: 60_000 });
    r.create('ABCD-EFGH');
    r.create('WXYZ-2345');
    expect(r.size()).toBe(2);
    c.avancar(61_000);
    expect(r.size()).toBe(0);
  });
});
