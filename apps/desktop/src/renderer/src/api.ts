import type { CreateRoomResponse } from '@game-share/shared';

const TOKEN_SERVER_URL = import.meta.env.VITE_TOKEN_SERVER_URL?.replace(/\/$/, '');

export class TokenServerError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'misconfigured' | 'rate-limited' | 'bad-response',
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

  if (res.status === 429) {
    throw new TokenServerError(
      'Você criou muitas transmissões em pouco tempo. Espere alguns minutos.',
      'rate-limited',
    );
  }

  if (!res.ok) {
    throw new TokenServerError(`Token server respondeu ${res.status}.`, 'bad-response');
  }

  return (await res.json()) as CreateRoomResponse;
}

/**
 * Encerra a sala no SFU para derrubar os espectadores imediatamente.
 * Best-effort: se falhar, a sala expira sozinha pelo emptyTimeout do LiveKit,
 * entao nunca bloqueamos o encerramento local por causa disto.
 */
export async function endRoom(roomId: string, publisherToken: string): Promise<boolean> {
  if (!TOKEN_SERVER_URL) return false;
  try {
    const res = await fetch(`${TOKEN_SERVER_URL}/api/rooms/${roomId}/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${publisherToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
