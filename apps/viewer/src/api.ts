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

/**
 * Depois disto, avisamos que o servidor pode estar acordando.
 *
 * Plano gratuito de hospedagem hiberna apos alguns minutos parado, e a
 * primeira chamada espera a instancia subir — de 30 a 60 segundos. Do lado de
 * quem recebeu o link isso e pior que no desktop: a pessoa nao sabe o que e
 * este site, ve "Conectando..." parado e fecha achando que o link e furada.
 */
const AVISAR_DEMORA_MS = 3_000;

/** Teto: acima disto nao ha o que esperar, e travar para sempre e pior. */
const TETO_MS = 90_000;

export async function fetchViewerToken(
  roomId: string,
  aoDemorar?: () => void,
): Promise<ViewerTokenResponse> {
  if (!TOKEN_SERVER_URL) {
    throw new ViewerApiError('Este viewer nao foi configurado (VITE_TOKEN_SERVER_URL).', 'misconfigured');
  }

  let res: Response;
  const aviso = aoDemorar ? setTimeout(aoDemorar, AVISAR_DEMORA_MS) : null;
  try {
    res = await fetch(`${TOKEN_SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/viewer-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TETO_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ViewerApiError(
        'O servidor da transmissão demorou demais para responder. Recarregue em um minuto.',
        'unreachable',
      );
    }
    throw new ViewerApiError('Nao foi possivel falar com o servidor da transmissao.', 'unreachable');
  } finally {
    if (aviso) clearTimeout(aviso);
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
