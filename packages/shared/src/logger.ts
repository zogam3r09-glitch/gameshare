export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinLevel(): LogLevel {
  const raw =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.LOG_LEVEL ?? 'debug';
  return raw in ORDER ? (raw as LogLevel) : 'debug';
}

const MIN_LEVEL = resolveMinLevel();

/**
 * Nunca logue tokens ou segredos inteiros. Use isto para qualquer credencial.
 * Mantem so o suficiente para correlacionar dois logs do mesmo token.
 */
export function redactToken(token: string | null | undefined): string {
  if (!token) return '<none>';
  return `${token.slice(0, 6)}…len=${token.length}`;
}

function stringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '<nao serializavel>';
  }
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[MIN_LEVEL]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    // Serializado numa string unica de proposito: o console do renderer do
    // Electron e espelhado no terminal como texto, e um segundo argumento
    // objeto chegaria la como "[object Object]".
    fn(data && Object.keys(data).length > 0 ? `${line} ${stringify(data)}` : line);
  };

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

/** Normaliza `unknown` de um catch para algo logavel/exibivel. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
