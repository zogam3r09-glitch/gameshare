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
  /** URL publica do proprio token-server; usada so para checar coerencia */
  tokenServerPublicUrl: string;
  /** criacoes de sala por IP, por janela */
  rateLimitRooms: number;
  /** pedidos de token de viewer por IP, por janela */
  rateLimitViewers: number;
  /** saltos de proxy confiaveis; 0 = nenhum (ver express `trust proxy`) */
  trustProxy: number;
}

export interface EnvResult {
  env: Env;
  /** Vazio quando tudo esta configurado. Nao derruba o processo: /health precisa responder. */
  problems: string[];
  /**
   * Incoerencias que nao impedem o servidor de subir, mas quebram em
   * producao de formas dificeis de diagnosticar: conteudo misto, CORS que
   * nunca casa, processo escutando so em loopback num host remoto.
   */
  warnings: string[];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Erros que so aparecem depois do deploy. Baratos de checar, caros de achar. */
export function checkCoherence(env: Env): string[] {
  const warnings: string[] = [];
  const viewerIsHttps = env.viewerBaseUrl.startsWith('https://');

  if (viewerIsHttps && env.livekitUrl.startsWith('ws://')) {
    warnings.push(
      'VITE_VIEWER_BASE_URL usa https mas LIVEKIT_URL usa ws:// — o navegador recusa WebSocket inseguro numa pagina segura. Use wss://',
    );
  }

  const tokenServerUrl = env.tokenServerPublicUrl;
  if (viewerIsHttps && tokenServerUrl.startsWith('http://')) {
    warnings.push(
      'VITE_VIEWER_BASE_URL usa https mas VITE_TOKEN_SERVER_URL usa http — a requisicao sera bloqueada como conteudo misto.',
    );
  }

  for (const origin of env.allowedOrigins) {
    if (origin.endsWith('/')) {
      warnings.push(
        `ALLOWED_ORIGINS contem "${origin}" com barra final — o header Origin nunca tem barra, entao essa entrada nunca vai casar.`,
      );
    }
  }

  const viewerOrigin = originOf(env.viewerBaseUrl);
  if (viewerOrigin && env.allowedOrigins.length > 0 && !env.allowedOrigins.includes(viewerOrigin)) {
    warnings.push(
      `ALLOWED_ORIGINS nao inclui "${viewerOrigin}", que e a origem do proprio viewer — ele vai levar CORS ao pedir token.`,
    );
  }

  if (env.host === '127.0.0.1' && viewerIsHttps) {
    warnings.push(
      'TOKEN_SERVER_HOST=127.0.0.1 com viewer publico — o processo so aceita conexoes locais e o host nao vai alcanca-lo. Use 0.0.0.0',
    );
  }

  return warnings;
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

  const env: Env = {
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    tokenTtlSeconds: num(source.TOKEN_TTL_SECONDS, 6 * 60 * 60),
    // PORT e a convencao de Railway/Render/Fly, que a injetam sozinhos
    port: num(source.TOKEN_SERVER_PORT ?? source.PORT, 8787),
    host: source.TOKEN_SERVER_HOST?.trim() || '127.0.0.1',
    // 10, nao 30: criar sala e a unica rota que consome cota do LiveKit e nao
    // exige credencial nenhuma. Com a API publica, o rate limit e a UNICA
    // barreira real — CORS nao vale para quem nao usa navegador. Dez
    // transmissoes em 15 minutos ja e muito para uso legitimo.
    rateLimitRooms: num(source.RATE_LIMIT_ROOMS, 10),
    rateLimitViewers: num(source.RATE_LIMIT_VIEWERS, 120),
    trustProxy: Number(source.TRUST_PROXY ?? 0) || 0,
    allowedOrigins: (source.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    viewerBaseUrl: source.VITE_VIEWER_BASE_URL?.trim() || 'http://localhost:5174',
    tokenServerPublicUrl: source.VITE_TOKEN_SERVER_URL?.trim() || '',
  };

  return { env, problems, warnings: checkCoherence(env) };
}
