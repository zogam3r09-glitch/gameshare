import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Cobre so o fluxo web do viewer (rota, estados, erros).
 * A permissao nativa de captura do Windows nao e automatizada de proposito:
 * seria fragil. Esse passo continua sendo teste manual (ver README).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // publisher sintetico: camera/microfone falsos, permissao auto-concedida
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @game-share/token-server start',
      cwd: repoRoot,
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @game-share/viewer dev',
      cwd: repoRoot,
      url: 'http://localhost:5174',
      // Fixa o token-server LOCAL em vez de herdar o .env. Sem isto, apontar o
      // .env para producao (que e o normal para gerar links publicos no
      // desktop) faz o viewer de teste pedir token para o servidor publicado,
      // cujo ALLOWED_ORIGINS nao inclui localhost — e todo e2e quebra por CORS,
      // com sintoma de "video nao aparece". Ja aconteceu.
      env: { VITE_TOKEN_SERVER_URL: 'http://127.0.0.1:8787' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
