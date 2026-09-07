import type { ViewerTokenResponse } from '@game-share/shared';

const TOKEN_SERVER_URL = (import.meta.env.VITE_TOKEN_SERVER_URL as string | undefined)?.replace(
  /\/$/,
  '',
);

export class ViewerApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'misconfigured' | 'not-found' | 'bad-response',
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
  if (res.status === 503) {
    throw new ViewerApiError('O servidor da transmissao esta indisponivel no momento.', 'misconfigured');
  }
  if (!res.ok) throw new ViewerApiError(`O servidor respondeu ${res.status}.`, 'bad-response');

  return (await res.json()) as ViewerTokenResponse;
}
