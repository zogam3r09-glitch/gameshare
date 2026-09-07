import { createLogger } from '@game-share/shared';
import { createApp } from './app.js';
import { loadEnv } from './env.js';

const log = createLogger('token-server');
const { env, problems } = loadEnv();

if (problems.length > 0) {
  log.warn('LiveKit NAO configurado - /health respondera 503 e a API vai recusar requisicoes', {
    problems,
    dica: 'copie .env.example para .env na raiz do monorepo',
  });
}

const app = createApp(env, problems);

const server = app.listen(env.port, env.host, () => {
  log.info('token-server no ar', {
    url: `http://${env.host}:${env.port}`,
    health: `http://${env.host}:${env.port}/health`,
    // NUNCA logar LIVEKIT_API_SECRET
    livekitUrl: env.livekitUrl || '<nao configurado>',
    allowedOrigins: env.allowedOrigins,
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`porta ${env.port} ja esta em uso - feche o outro processo ou mude TOKEN_SERVER_PORT`);
  } else {
    log.error('falha ao subir o servidor', { message: err.message });
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} recebido, encerrando`);
    server.close(() => process.exit(0));
  });
}
