import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  buildWatchUrl,
  createLogger,
  errorMessage,
  generateRoomId,
  isValidRoomId,
  normalizeRoomId,
  redactToken,
  type ApiErrorResponse,
  type CreateRoomResponse,
  type HealthResponse,
  type ViewerTokenResponse,
} from '@game-share/shared';
import type { Env } from './env.js';
import { issuePublisherToken, issueViewerToken } from './tokens.js';

const log = createLogger('token-server');
const VERSION = '0.1.0';
const startedAt = Date.now();

function fail(res: Response, status: number, body: ApiErrorResponse): void {
  res.status(status).json(body);
}

export function createApp(env: Env, problems: string[]): express.Express {
  const app = express();
  const configured = problems.length === 0;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.use(
    cors({
      origin(origin, callback) {
        // Sem Origin = curl/health check. Electron empacotado (file://) manda "null";
        // adicione `null` em ALLOWED_ORIGINS se for usar a build empacotada.
        if (!origin || env.allowedOrigins.includes(origin)) return callback(null, true);
        log.warn('origin bloqueada por CORS', { origin });
        return callback(null, false);
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: configured ? 'ok' : 'degraded',
      service: 'token-server',
      version: VERSION,
      livekitConfigured: configured,
      livekitUrl: configured ? env.livekitUrl : null,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
    res.status(configured ? 200 : 503).json(body);
  });

  const requireConfig = (_req: Request, res: Response, next: NextFunction): void => {
    if (configured) return next();
    log.error('requisicao recusada: LiveKit nao configurado', { problems });
    fail(res, 503, {
      code: 'SERVER_MISCONFIGURED',
      error: `Token server sem configuracao de LiveKit: ${problems.join('; ')}`,
    });
  };

  /** O roomId e gerado AQUI. O cliente nunca escolhe o nome da sala. */
  app.post('/api/rooms', requireConfig, (_req, res, next) => {
    const roomId = generateRoomId();
    issuePublisherToken({
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret,
      roomId,
      ttlSeconds: env.tokenTtlSeconds,
    })
      .then((issued) => {
        log.info('sala criada', {
          roomId,
          identity: issued.identity,
          token: redactToken(issued.token),
        });
        const body: CreateRoomResponse = {
          roomId,
          token: issued.token,
          identity: issued.identity,
          livekitUrl: env.livekitUrl,
          watchUrl: buildWatchUrl(env.viewerBaseUrl, roomId),
          expiresAt: issued.expiresAt,
        };
        res.status(201).json(body);
      })
      .catch(next);
  });

  app.post('/api/rooms/:roomId/viewer-token', requireConfig, (req, res, next) => {
    const roomId = normalizeRoomId(String(req.params.roomId ?? ''));
    if (!isValidRoomId(roomId)) {
      log.warn('roomId invalido recusado');
      fail(res, 400, { code: 'INVALID_ROOM_ID', error: 'Codigo de sala invalido.' });
      return;
    }

    issueViewerToken({
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret,
      roomId,
      ttlSeconds: env.tokenTtlSeconds,
    })
      .then((issued) => {
        log.info('token de viewer emitido', {
          roomId,
          identity: issued.identity,
          token: redactToken(issued.token),
        });
        const body: ViewerTokenResponse = {
          roomId,
          token: issued.token,
          identity: issued.identity,
          livekitUrl: env.livekitUrl,
          expiresAt: issued.expiresAt,
        };
        res.json(body);
      })
      .catch(next);
  });

  app.use((_req, res) => {
    fail(res, 404, { code: 'NOT_FOUND', error: 'Rota inexistente.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('erro nao tratado', { message: errorMessage(err) });
    fail(res, 500, { code: 'INTERNAL', error: 'Erro interno no token server.' });
  });

  return app;
}
