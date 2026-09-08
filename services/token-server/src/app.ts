import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
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
  type EndRoomResponse,
  type HealthResponse,
  type ViewerTokenResponse,
} from '@game-share/shared';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Env } from './env.js';
import { RoomRegistry } from './rooms.js';
import { isPublisherOf, issuePublisherToken, issueViewerToken } from './tokens.js';

const log = createLogger('token-server');
const VERSION = '0.1.0';
const startedAt = Date.now();

function fail(res: Response, status: number, body: ApiErrorResponse): void {
  res.status(status).json(body);
}

/** O RoomService fala HTTP; LIVEKIT_URL e ws(s)://. */
export function livekitHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/i, 'http');
}

/** Extrai o bearer token do header Authorization. */
function bearer(req: Request): string | null {
  const header = req.get('authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match ? match[1]!.trim() : null;
}

export interface AppDeps {
  /** Injetavel para os testes rodarem sem um LiveKit de verdade. */
  deleteRoom?: (roomId: string) => Promise<void>;
  /** Injetavel para os testes controlarem expiracao sem esperar. */
  registry?: RoomRegistry;
}

export function createApp(env: Env, problems: string[], deps: AppDeps = {}): express.Express {
  const app = express();
  const configured = problems.length === 0;

  const registry = deps.registry ?? new RoomRegistry();

  const deleteRoom =
    deps.deleteRoom ??
    ((roomId: string) =>
      new RoomServiceClient(
        livekitHttpUrl(env.livekitUrl),
        env.livekitApiKey,
        env.livekitApiSecret,
      ).deleteRoom(roomId));

  app.disable('x-powered-by');
  // Atras de proxy/CDN o IP real vem no X-Forwarded-For. Sem isto o rate limit
  // veria um IP so e limitaria todo mundo junto. Fica 0 (desligado) por padrao,
  // porque confiar no header sem proxy na frente e falsificavel.
  app.set('trust proxy', env.trustProxy);
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

  /**
   * Criar sala e a rota cara: aloca sala no SFU e assina um token de
   * publisher. Sem limite, um loop simples enche o servidor de salas.
   * Pedir token de viewer e mais barato e legitimamente mais frequente
   * (cada espectador pede ao entrar), entao tem folga maior.
   */
  const limiter = (max: number): ReturnType<typeof rateLimit> =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { code: 'RATE_LIMITED', error: 'Muitas requisicoes. Tente de novo em alguns minutos.' },
      handler: (req, res, _next, options) => {
        log.warn('rate limit atingido', { rota: req.path });
        res.status(options.statusCode).json(options.message);
      },
    });

  const roomsLimiter = limiter(env.rateLimitRooms);
  const viewersLimiter = limiter(env.rateLimitViewers);

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
  app.post('/api/rooms', roomsLimiter, requireConfig, (_req, res, next) => {
    const roomId = generateRoomId();
    issuePublisherToken({
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret,
      roomId,
      ttlSeconds: env.tokenTtlSeconds,
    })
      .then((issued) => {
        registry.create(roomId);
        log.info('sala criada', {
          roomId,
          identity: issued.identity,
          token: redactToken(issued.token),
          salasLembradas: registry.size(),
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

  app.post('/api/rooms/:roomId/viewer-token', viewersLimiter, requireConfig, (req, res, next) => {
    const roomId = normalizeRoomId(String(req.params.roomId ?? ''));
    if (!isValidRoomId(roomId)) {
      log.warn('roomId invalido recusado');
      fail(res, 400, { code: 'INVALID_ROOM_ID', error: 'Codigo de sala invalido.' });
      return;
    }

    // Sala desconhecida continua recebendo token de proposito: o processo pode
    // ter reiniciado com a transmissao no ar. So recusamos o que sabemos ter
    // terminado. Ver o comentario em RoomRegistry.
    const known = registry.get(roomId);
    if (known?.endedAt !== null && known !== null) {
      log.info('token recusado: sala ja encerrada', { roomId });
      fail(res, 410, { code: 'ROOM_ENDED', error: 'Esta transmissao ja foi encerrada.' });
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

  /**
   * Encerra a sala no SFU, derrubando os espectadores na hora em vez de
   * esperar o emptyTimeout. Autorizado pelo token de PUBLISHER da sala: quem
   * so tem o link recebeu um token de viewer e nao consegue encerrar nada.
   */
  app.post('/api/rooms/:roomId/end', requireConfig, (req, res, next) => {
    const roomId = normalizeRoomId(String(req.params.roomId ?? ''));
    if (!isValidRoomId(roomId)) {
      fail(res, 400, { code: 'INVALID_ROOM_ID', error: 'Codigo de sala invalido.' });
      return;
    }

    const token = bearer(req);
    if (!token) {
      fail(res, 401, { code: 'UNAUTHORIZED', error: 'Token de publisher ausente.' });
      return;
    }

    isPublisherOf(env.livekitApiKey, env.livekitApiSecret, token, roomId)
      .then(async (allowed) => {
        if (!allowed) {
          log.warn('tentativa de encerrar sala sem permissao', { roomId });
          fail(res, 403, {
            code: 'UNAUTHORIZED',
            error: 'Este token nao pode encerrar esta transmissao.',
          });
          return;
        }

        registry.markEnded(roomId);

        let deleted = true;
        try {
          await deleteRoom(roomId);
          log.info('sala encerrada no SFU', { roomId });
        } catch (err) {
          // encerrar uma sala ja vazia/inexistente nao e erro do cliente
          deleted = false;
          log.warn('deleteRoom falhou (sala ja encerrada?)', {
            roomId,
            message: errorMessage(err),
          });
        }

        const body: EndRoomResponse = { roomId, deleted };
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
