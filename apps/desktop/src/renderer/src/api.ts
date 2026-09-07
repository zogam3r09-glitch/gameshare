import type { CreateRoomResponse } from '@game-share/shared';

const TOKEN_SERVER_URL = import.meta.env.VITE_TOKEN_SERVER_URL?.replace(/\/$/, '');

export class TokenServerError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'misconfigured' | 'bad-response',
  ) {
    super(message);
    this.name = 'TokenServerError';
  }
}

export async function createRoom(): Promise<CreateRoomResponse> {
  if (!TOKEN_SERVER_URL) {
    throw new TokenServerError(
      'VITE_TOKEN_SERVER_URL nao configurada. Copie .env.example para .env na raiz.',
      'misconfigured',
    );
  }

  let res: Response;
  try {
    res = await fetch(`${TOKEN_SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    throw new TokenServerError(
      `Token server inacessivel em ${TOKEN_SERVER_URL}. Rode "pnpm dev:server".`,
      'unreachable',
    );
  }

  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new TokenServerError(
      body?.error ?? 'Token server sem configuracao de LiveKit.',
      'misconfigured',
    );
  }

  if (!res.ok) {
    throw new TokenServerError(`Token server respondeu ${res.status}.`, 'bad-response');
  }

  return (await res.json()) as CreateRoomResponse;
}
