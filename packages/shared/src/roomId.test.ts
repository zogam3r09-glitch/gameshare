import { describe, expect, it } from 'vitest';
import {
  ROOM_ID_REGEX,
  buildWatchUrl,
  generateRoomId,
  isValidRoomId,
  normalizeRoomId,
  parseWatchPath,
} from './roomId.js';

describe('generateRoomId', () => {
  it('gera no formato XXXX-XXXX', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRoomId()).toMatch(ROOM_ID_REGEX);
    }
  });

  it('nao usa caracteres ambiguos (0 1 I O)', () => {
    const joined = Array.from({ length: 500 }, generateRoomId).join('');
    expect(joined).not.toMatch(/[01IO]/);
  });

  it('usa o alfabeto inteiro (nenhum simbolo fica orfao)', () => {
    const seen = new Set(Array.from({ length: 3000 }, generateRoomId).join('').replace(/-/g, ''));
    expect(seen.size).toBe(32);
  });

  it('nao e sequencial: 2000 ids sao praticamente todos distintos', () => {
    const ids = new Set(Array.from({ length: 2000 }, generateRoomId));
    expect(ids.size).toBeGreaterThan(1990);
  });
});

describe('isValidRoomId', () => {
  it.each(['ABCD-EFGH', '2345-6789', 'ZZZZ-2222'])('aceita %s', (v) => {
    expect(isValidRoomId(v)).toBe(true);
  });

  it.each([
    'abcd-efgh', // minusculas
    'ABCDEFGH', // sem hifen
    'ABCD-EFG', // curto
    'ABCD-EFGHI', // longo
    'ABCD-EFG0', // zero proibido
    'ABCD-EFGI', // I proibido
    '',
    '../../etc/passwd',
    null,
    undefined,
    42,
  ])('rejeita %s', (v) => {
    expect(isValidRoomId(v)).toBe(false);
  });
});

describe('normalizeRoomId', () => {
  it('faz upper e trim', () => {
    expect(normalizeRoomId('  abcd-efgh \n')).toBe('ABCD-EFGH');
  });
});

describe('buildWatchUrl', () => {
  it('monta a partir de localhost', () => {
    expect(buildWatchUrl('http://localhost:5174', 'ABCD-EFGH')).toBe(
      'http://localhost:5174/watch/ABCD-EFGH',
    );
  });

  it('monta a partir de um dominio (troca de infra sem mudar codigo)', () => {
    expect(buildWatchUrl('https://gameshare.gg', 'ABCD-EFGH')).toBe(
      'https://gameshare.gg/watch/ABCD-EFGH',
    );
  });
});

describe('parseWatchPath', () => {
  it('extrai o roomId', () => {
    expect(parseWatchPath('/watch/ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(parseWatchPath('/watch/abcd-efgh')).toBe('ABCD-EFGH');
    expect(parseWatchPath('/watch/ABCD-EFGH/')).toBe('ABCD-EFGH');
  });

  it('retorna null para rotas/ids invalidos', () => {
    expect(parseWatchPath('/')).toBeNull();
    expect(parseWatchPath('/watch/')).toBeNull();
    expect(parseWatchPath('/watch/NOPE')).toBeNull();
    expect(parseWatchPath('/watch/ABCD-EFGH/extra')).toBeNull();
  });
});
