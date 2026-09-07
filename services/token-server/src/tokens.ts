import { AccessToken, TokenVerifier, type VideoGrant } from 'livekit-server-sdk';
import { newPublisherIdentity, newViewerIdentity } from '@game-share/shared';

/**
 * As permissoes sao decididas SOMENTE aqui, no servidor.
 * Nada do que o cliente envia influencia os grants.
 */
export const PUBLISHER_GRANT = (room: string): VideoGrant => ({
  room,
  roomJoin: true,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
  canUpdateOwnMetadata: false,
});

export const VIEWER_GRANT = (room: string): VideoGrant => ({
  room,
  roomJoin: true,
  canPublish: false,
  canSubscribe: true,
  canPublishData: false,
  canUpdateOwnMetadata: false,
});

export interface IssuedToken {
  token: string;
  identity: string;
  expiresAt: number;
}

interface IssueOptions {
  apiKey: string;
  apiSecret: string;
  roomId: string;
  ttlSeconds: number;
}

async function issue(
  { apiKey, apiSecret, ttlSeconds }: Omit<IssueOptions, 'roomId'>,
  identity: string,
  grant: VideoGrant,
  name: string,
): Promise<IssuedToken> {
  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: ttlSeconds });
  at.addGrant(grant);
  return {
    token: await at.toJwt(),
    identity,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

export function issuePublisherToken(opts: IssueOptions): Promise<IssuedToken> {
  return issue(opts, newPublisherIdentity(), PUBLISHER_GRANT(opts.roomId), 'Streamer');
}

export function issueViewerToken(opts: IssueOptions): Promise<IssuedToken> {
  return issue(opts, newViewerIdentity(), VIEWER_GRANT(opts.roomId), 'Espectador');
}

/**
 * Prova de que quem chamou e o streamer daquela sala.
 *
 * O proprio token de publisher e a credencial: quem tem o link so recebeu um
 * token de viewer (sem canPublish), entao nao consegue encerrar a transmissao
 * de outra pessoa. Nao precisamos guardar estado nenhum para isso.
 */
export async function isPublisherOf(
  apiKey: string,
  apiSecret: string,
  token: string,
  roomId: string,
): Promise<boolean> {
  try {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
    return claims.video?.room === roomId && claims.video?.canPublish === true;
  } catch {
    return false;
  }
}
