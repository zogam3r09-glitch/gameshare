/**
 * Identidades do LiveKit sao publicas e visiveis para todos os participantes.
 * Usamos um prefixo para que o viewer consiga contar espectadores usando
 * apenas API publica (`room.remoteParticipants`), sem inventar metadados.
 */
export const PUBLISHER_PREFIX = 'pub-';
export const VIEWER_PREFIX = 'view-';

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newPublisherIdentity(): string {
  return PUBLISHER_PREFIX + randomSuffix();
}

export function newViewerIdentity(): string {
  return VIEWER_PREFIX + randomSuffix();
}

export function isPublisherIdentity(identity: string): boolean {
  return identity.startsWith(PUBLISHER_PREFIX);
}

export function isViewerIdentity(identity: string): boolean {
  return identity.startsWith(VIEWER_PREFIX);
}
