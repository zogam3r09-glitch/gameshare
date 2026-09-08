import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TokenVerifier } from 'livekit-server-sdk';
import { ROOM_ID_REGEX, isPublisherIdentity, isViewerIdentity } from '@game-share/shared';
import { createApp, livekitHttpUrl } from './app.js';
import { loadEnv } from './env.js';
import { issuePublisherToken, issueViewerToken } from './tokens.js';

const API_KEY = 'testkey';
const API_SECRET = 'testsecret-testsecret-testsecret-32';
const ROOM = 'ABCD-EFGH';

const verifier = new TokenVerifier(API_KEY, API_SECRET);

describe('permissoes dos tokens', () => {
  const opts = { apiKey: API_KEY, apiSecret: API_SECRET, roomId: ROOM, ttlSeconds: 60 };

  it('publisher pode publicar e assinar', async () => {
    const { token, identity } = await issuePublisherToken(opts);
    const claims = await verifier.verify(token);
    expect(claims.video).toMatchObject({
      room: ROOM,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    expect(isPublisherIdentity(identity)).toBe(true);
  });

  it('viewer assina mas NAO pode publicar', async () => {
    const { token, identity } = await issueViewerToken(opts);
    const claims = await verifier.verify(token);
    expect(claims.video).toMatchObject({
      room: ROOM,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });
    expect(isViewerIdentity(identity)).toBe(true);
  });

  it('token e escopado a uma unica sala', async () => {
    const { token } = await issueViewerToken({ ...opts, roomId: 'ZZZZ-2222' });
    const claims = await verifier.verify(token);
    expect(claims.video?.room).toBe('ZZZZ-2222');
    expect(claims.video?.room).not.toBe(ROOM);
  });
});

describe('HTTP', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { env } = loadEnv({
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: API_KEY,
      LIVEKIT_API_SECRET: API_SECRET,
      VITE_VIEWER_BASE_URL: 'http://localhost:5174',
      ALLOWED_ORIGINS: 'http://localhost:5174',
    } as NodeJS.ProcessEnv);

    server = createApp(env, []).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('GET /health responde ok', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'token-server',
      livekitConfigured: true,
    });
  });

  it('POST /api/rooms cria sala com id imprevisivel e watchUrl', async () => {
    const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roomId: string; watchUrl: string; token: string };
    expect(body.roomId).toMatch(ROOM_ID_REGEX);
    expect(body.watchUrl).toBe(`http://localhost:5174/watch/${body.roomId}`);
    expect((await verifier.verify(body.token)).video?.canPublish).toBe(true);
  });

  it('dois POST /api/rooms geram salas diferentes (nao incremental)', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map(async () => {
        const r = await fetch(`${base}/api/rooms`, { method: 'POST' });
        return ((await r.json()) as { roomId: string }).roomId;
      }),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('viewer-token recusa roomId invalido', async () => {
    const res = await fetch(`${base}/api/rooms/nao-existe/viewer-token`, { method: 'POST' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_ROOM_ID' });
  });

  it('viewer-token aceita roomId valido e devolve token sem canPublish', async () => {
    const res = await fetch(`${base}/api/rooms/${ROOM}/viewer-token`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; livekitUrl: string };
    expect(body.livekitUrl).toBe('ws://127.0.0.1:7880');
    expect((await verifier.verify(body.token)).video?.canPublish).toBe(false);
  });

  it('nenhuma resposta vaza o API secret', async () => {
    for (const path of ['/health', '/api/rooms']) {
      const res = await fetch(`${base}${path}`, { method: path === '/health' ? 'GET' : 'POST' });
      expect(await res.text()).not.toContain(API_SECRET);
    }
  });

  it('404 para rota desconhecida', async () => {
    const res = await fetch(`${base}/qualquer-coisa`);
    expect(res.status).toBe(404);
  });
});

describe('livekitHttpUrl', () => {
  it('converte o esquema mantendo host e porta', () => {
    expect(livekitHttpUrl('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
    expect(livekitHttpUrl('wss://x.livekit.cloud')).toBe('https://x.livekit.cloud');
  });
});

describe('POST /api/rooms/:roomId/end', () => {
  let server: Server;
  let base: string;
  const deleted: string[] = [];

  beforeAll(async () => {
    const { env } = loadEnv({
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: API_KEY,
      LIVEKIT_API_SECRET: API_SECRET,
    } as NodeJS.ProcessEnv);

    server = createApp(env, [], {
      deleteRoom: async (roomId) => {
        if (roomId === 'ZZZZ-9999') throw new Error('sala inexistente');
        deleted.push(roomId);
      },
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const end = (roomId: string, token?: string): Promise<Response> =>
    fetch(`${base}/api/rooms/${roomId}/end`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  const opts = { apiKey: API_KEY, apiSecret: API_SECRET, roomId: ROOM, ttlSeconds: 60 };

  it('o publisher encerra a propria sala', async () => {
    const { token } = await issuePublisherToken(opts);
    const res = await end(ROOM, token);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ roomId: ROOM, deleted: true });
    expect(deleted).toContain(ROOM);
  });

  it('o viewer NAO pode encerrar a transmissao', async () => {
    const { token } = await issueViewerToken(opts);
    const res = await end(ROOM, token);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('o publisher de outra sala NAO pode encerrar esta', async () => {
    const { token } = await issuePublisherToken({ ...opts, roomId: 'WXYZ-2345' });
    expect((await end(ROOM, token)).status).toBe(403);
  });

  it('sem Authorization responde 401', async () => {
    expect((await end(ROOM)).status).toBe(401);
  });

  it('token assinado com outro segredo responde 403', async () => {
    const { token } = await issuePublisherToken({ ...opts, apiSecret: 'outro-segredo-com-32-caracteres!!' });
    expect((await end(ROOM, token)).status).toBe(403);
  });

  it('roomId malformado responde 400 antes de olhar o token', async () => {
    expect((await end('nao-existe')).status).toBe(400);
  });

  it('encerrar sala ja inexistente responde 200 com deleted:false', async () => {
    const { token } = await issuePublisherToken({ ...opts, roomId: 'ZZZZ-9999' });
    const res = await end('ZZZZ-9999', token);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });
});

describe('rate limiting', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { env } = loadEnv({
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: API_KEY,
      LIVEKIT_API_SECRET: API_SECRET,
      RATE_LIMIT_ROOMS: '3',
      RATE_LIMIT_VIEWERS: '5',
    } as NodeJS.ProcessEnv);

    expect(env.rateLimitRooms).toBe(3);
    expect(env.rateLimitViewers).toBe(5);

    server = createApp(env, [], { deleteRoom: async () => undefined }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('bloqueia criacao de sala acima do limite, com 429 e codigo proprio', async () => {
    const status: number[] = [];
    for (let i = 0; i < 5; i++) {
      status.push((await fetch(`${base}/api/rooms`, { method: 'POST' })).status);
    }
    // 3 permitidas, o resto barrado
    expect(status.slice(0, 3)).toEqual([201, 201, 201]);
    expect(status.slice(3)).toEqual([429, 429]);

    const blocked = await fetch(`${base}/api/rooms`, { method: 'POST' });
    await expect(blocked.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('viewer-token tem folga maior e limite proprio', async () => {
    // a rota de salas ja esta estourada; esta ainda responde
    const first = await fetch(`${base}/api/rooms/${ROOM}/viewer-token`, { method: 'POST' });
    expect(first.status).toBe(200);

    const status: number[] = [];
    for (let i = 0; i < 6; i++) {
      status.push(
        (await fetch(`${base}/api/rooms/${ROOM}/viewer-token`, { method: 'POST' })).status,
      );
    }
    expect(status.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('/health nunca e limitado: o monitoramento nao pode ser cortado', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    }
  });
});

describe('env', () => {
  it('usa PORT quando TOKEN_SERVER_PORT nao existe (Railway/Render/Fly)', () => {
    expect(loadEnv({ PORT: '3000' } as NodeJS.ProcessEnv).env.port).toBe(3000);
  });

  it('TOKEN_SERVER_PORT tem precedencia sobre PORT', () => {
    expect(
      loadEnv({ PORT: '3000', TOKEN_SERVER_PORT: '8787' } as NodeJS.ProcessEnv).env.port,
    ).toBe(8787);
  });

  it('trust proxy fica desligado por padrao', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).env.trustProxy).toBe(0);
  });
});

describe('coerencia de configuracao para producao', () => {
  const remote = (extra: Record<string, string>): string[] =>
    loadEnv({
      LIVEKIT_URL: 'wss://x.livekit.cloud',
      LIVEKIT_API_KEY: API_KEY,
      LIVEKIT_API_SECRET: API_SECRET,
      TOKEN_SERVER_HOST: '0.0.0.0',
      VITE_VIEWER_BASE_URL: 'https://viewer.exemplo.com',
      VITE_TOKEN_SERVER_URL: 'https://api.exemplo.com',
      ALLOWED_ORIGINS: 'https://viewer.exemplo.com',
      ...extra,
    } as NodeJS.ProcessEnv).warnings;

  it('config remota correta nao gera aviso', () => {
    expect(remote({})).toEqual([]);
  });

  it('a config local padrao tambem nao gera aviso', () => {
    expect(
      loadEnv({
        LIVEKIT_URL: 'ws://127.0.0.1:7880',
        LIVEKIT_API_KEY: API_KEY,
        LIVEKIT_API_SECRET: API_SECRET,
        ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5174',
        VITE_VIEWER_BASE_URL: 'http://localhost:5174',
        VITE_TOKEN_SERVER_URL: 'http://127.0.0.1:8787',
      } as NodeJS.ProcessEnv).warnings,
    ).toEqual([]);
  });

  it('avisa sobre ws:// com viewer em https', () => {
    expect(remote({ LIVEKIT_URL: 'ws://1.2.3.4:7880' }).join(' ')).toMatch(/wss/);
  });

  it('avisa sobre token-server em http com viewer em https', () => {
    expect(remote({ VITE_TOKEN_SERVER_URL: 'http://api.exemplo.com' }).join(' ')).toMatch(
      /conteudo misto/,
    );
  });

  it('avisa sobre origem com barra final', () => {
    expect(remote({ ALLOWED_ORIGINS: 'https://viewer.exemplo.com/' }).join(' ')).toMatch(
      /barra final/,
    );
  });

  it('avisa quando a origem do viewer nao esta em ALLOWED_ORIGINS', () => {
    expect(remote({ ALLOWED_ORIGINS: 'https://outro.exemplo.com' }).join(' ')).toMatch(/CORS/);
  });

  it('avisa sobre escutar so em loopback com viewer publico', () => {
    expect(remote({ TOKEN_SERVER_HOST: '127.0.0.1' }).join(' ')).toMatch(/0\.0\.0\.0/);
  });
});

describe('servidor mal configurado', () => {
  it('/health responde 503 e a API recusa', async () => {
    const { env, problems } = loadEnv({} as NodeJS.ProcessEnv);
    expect(problems.length).toBeGreaterThan(0);

    const srv = createApp(env, problems).listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.once('listening', resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    expect((await fetch(`${url}/health`)).status).toBe(503);
    const res = await fetch(`${url}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'SERVER_MISCONFIGURED' });

    srv.close();
  });
});
