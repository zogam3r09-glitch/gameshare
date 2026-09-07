import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TokenVerifier } from 'livekit-server-sdk';
import { ROOM_ID_REGEX, isPublisherIdentity, isViewerIdentity } from '@game-share/shared';
import { createApp } from './app.js';
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
