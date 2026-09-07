import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
/** .env unico na raiz do monorepo (services/token-server/src -> ../../..) */
export const REPO_ROOT = path.resolve(here, '../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export interface Env {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  tokenTtlSeconds: number;
  port: number;
  host: string;
  allowedOrigins: string[];
  viewerBaseUrl: string;
}

export interface EnvResult {
  env: Env;
  /** Vazio quando tudo esta configurado. Nao derruba o processo: /health precisa responder. */
  problems: string[];
}

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): EnvResult {
  const problems: string[] = [];

  const livekitUrl = source.LIVEKIT_URL?.trim() ?? '';
  const livekitApiKey = source.LIVEKIT_API_KEY?.trim() ?? '';
  const livekitApiSecret = source.LIVEKIT_API_SECRET?.trim() ?? '';

  if (!livekitUrl) problems.push('LIVEKIT_URL ausente');
  else if (!/^wss?:\/\//i.test(livekitUrl)) problems.push('LIVEKIT_URL deve comecar com ws:// ou wss://');
  if (!livekitApiKey) problems.push('LIVEKIT_API_KEY ausente');
  if (!livekitApiSecret) problems.push('LIVEKIT_API_SECRET ausente');
  else if (livekitApiSecret.length < 32) problems.push('LIVEKIT_API_SECRET deve ter ao menos 32 caracteres');

  return {
    problems,
    env: {
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      tokenTtlSeconds: num(source.TOKEN_TTL_SECONDS, 6 * 60 * 60),
      port: num(source.TOKEN_SERVER_PORT, 8787),
      host: source.TOKEN_SERVER_HOST?.trim() || '127.0.0.1',
      allowedOrigins: (source.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      viewerBaseUrl: source.VITE_VIEWER_BASE_URL?.trim() || 'http://localhost:5174',
    },
  };
}
