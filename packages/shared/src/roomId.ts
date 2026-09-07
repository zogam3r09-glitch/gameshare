/**
 * Identificador de sala legivel e imprevisivel.
 *
 * Alfabeto de 32 simbolos: digitos 2-9 + letras exceto I e O. Ficam de fora
 * justamente os pares que se confundem lendo em voz alta ou no chat (0/O, 1/I).
 * 8 simbolos = 40 bits de entropia, formatado XXXX-XXXX.
 * 256 % 32 === 0, entao `byte % 32` e uniforme (sem vies de modulo).
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const GROUP = 4;
const GROUPS = 2;

export const ROOM_ID_LENGTH = GROUP * GROUPS;
export const ROOM_ID_REGEX = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

/** Gera um roomId aleatorio. Nunca use contador incremental. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(ROOM_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let out = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    if (i > 0 && i % GROUP === 0) out += '-';
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_REGEX.test(value);
}

/** Aceita entrada do usuario em minusculas / com espacos. */
export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase();
}

/** Monta a URL publica de assistir. `baseUrl` pode ser localhost ou dominio. */
export function buildWatchUrl(baseUrl: string, roomId: string): string {
  return new URL(`/watch/${roomId}`, baseUrl).toString();
}

/** Extrai o roomId de um pathname `/watch/XXXX-XXXX`. Retorna null se invalido. */
export function parseWatchPath(pathname: string): string | null {
  const match = /^\/watch\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const candidate = normalizeRoomId(decodeURIComponent(match[1]!));
  return isValidRoomId(candidate) ? candidate : null;
}
