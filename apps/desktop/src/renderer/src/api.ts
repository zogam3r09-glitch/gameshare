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

/**
 * Depois disto, avisamos que o servidor pode estar acordando.
 *
 * Plano gratuito de hospedagem hiberna o servico apos alguns minutos parado,
 * e a primeira chamada seguinte espera a instancia subir — na pratica algo
 * entre 30 e 60 segundos. Sem aviso a tela fica em "CRIANDO..." e parece
 * travada, o que faz a pessoa fechar o app justamente quando faltava esperar.
 */
const AVISAR_DEMORA_MS = 3_000;

/** Teto: acima disto nao ha o que esperar, e travar para sempre e pior. */
const TETO_MS = 90_000;

export async function createRoom(aoDemorar?: () => void): Promise<CreateRoomResponse> {
  if (!TOKEN_SERVER_URL) {
    throw new TokenServerError(
      'VITE_TOKEN_SERVER_URL nao configurada. Copie .env.example para .env na raiz.',
      'misconfigured',
    );
  }

  let res: Response;
  const aviso = aoDemorar ? setTimeout(aoDemorar, AVISAR_DEMORA_MS) : null;
  try {
    res = await fetch(`${TOKEN_SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TETO_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TokenServerError(
        `O token server nao respondeu em ${TETO_MS / 1000}s. ` +
          'Se ele esta num plano gratuito, pode estar hibernando: tente de novo em um minuto.',
        'unreachable',
      );
    }
    /**
     * Um fetch bloqueado por CORS falha de forma indistinguivel de servidor
     * fora do ar: o navegador nao conta qual dos dois foi. A mensagem precisa
     * citar as duas causas, senao manda investigar o lado errado — foi o que
     * aconteceu quando o desktop passou a apontar para producao e a origem
     * dele nao estava em ALLOWED_ORIGINS.
     */
    const local = /localhost|127\.0\.0\.1/.test(TOKEN_SERVER_URL ?? '');
    throw new TokenServerError(
      `Nao foi possivel falar com o token server em ${TOKEN_SERVER_URL}. ` +
        (local
          ? 'Ele esta rodando? Use "pnpm dev:server".'
          : 'Pode estar fora do ar, ou a origem deste app pode nao estar em ALLOWED_ORIGINS no servidor.'),
      'unreachable',
    );
  } finally {
    if (aviso) clearTimeout(aviso);
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
