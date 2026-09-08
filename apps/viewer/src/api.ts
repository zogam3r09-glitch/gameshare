import type { ViewerTokenResponse } from '@game-share/shared';

const TOKEN_SERVER_URL = (import.meta.env.VITE_TOKEN_SERVER_URL as string | undefined)?.replace(
  /\/$/,
  '',
);

export class ViewerApiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unreachable'
      | 'misconfigured'
      | 'not-found'
      | 'ended'
      | 'rate-limited'
      | 'bad-response',
  ) {
    super(message);
    this.name = 'ViewerApiError';
  }
}

export async function fetchViewerToken(roomId: string): Promise<ViewerTokenResponse> {
  if (!TOKEN_SERVER_URL) {
    throw new ViewerApiError('Este viewer nao foi configurado (VITE_TOKEN_SERVER_URL).', 'misconfigured');
  }

  let res: Response;
  try {
    res = await fetch(`${TOKEN_SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/viewer-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    throw new ViewerApiError('Nao foi possivel falar com o servidor da transmissao.', 'unreachable');
  }

  if (res.status === 400) throw new ViewerApiError('Este link de transmissao e invalido.', 'not-found');
  // 410: o servidor sabe que esta sala existiu e ja terminou
  if (res.status === 410) throw new ViewerApiError('Esta transmissao ja foi encerrada.', 'ended');
  if (res.status === 503) {
    throw new ViewerApiError('O servidor da transmissao esta indisponivel no momento.', 'misconfigured');
  }
  if (res.status === 429) {
    throw new ViewerApiError(
      'Muitas tentativas em pouco tempo. Espere alguns minutos e recarregue.',
      'rate-limited',
    );
  }
  if (!res.ok) throw new ViewerApiError(`O servidor respondeu ${res.status}.`, 'bad-response');

  return (await res.json()) as ViewerTokenResponse;
}
