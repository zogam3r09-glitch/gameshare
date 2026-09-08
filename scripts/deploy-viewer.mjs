#!/usr/bin/env node
/**
 * Publica o viewer no Cloudflare Pages.
 *
 * Existe porque o caminho manual tem duas armadilhas silenciosas:
 *
 * 1. VITE_TOKEN_SERVER_URL e embutida no BUILD. Buildar com o valor errado
 *    publica um site que aponta para localhost, e o erro so aparece quando
 *    alguem de fora abre o link.
 * 2. wrangler precisa de CLOUDFLARE_ACCOUNT_ID quando o token tem escopo
 *    apenas de Pages, e a mensagem de erro sem ele fala de "permissoes
 *    incorretas", mandando investigar o lado errado.
 *
 * Este script falha cedo e com mensagem util em vez de publicar algo quebrado.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJETO = 'gameshare';

/** .env da raiz + ambiente. O ambiente vence, para CI poder sobrescrever. */
async function carregarEnv() {
  const doArquivo = await readFile(path.join(ROOT, '.env'), 'utf8')
    .then((raw) =>
      Object.fromEntries(
        raw
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
          .map((l) => {
            const i = l.indexOf('=');
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }),
      ),
    )
    .catch(() => ({}));
  return { ...doArquivo, ...process.env };
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} saiu com codigo ${code}`)),
    );
  });
}

const env = await carregarEnv();
const faltando = [];

const tokenServer = env.VITE_TOKEN_SERVER_URL;
if (!tokenServer) faltando.push('VITE_TOKEN_SERVER_URL (no .env)');
else if (/localhost|127\.0\.0\.1/.test(tokenServer)) {
  console.error(`\nRECUSADO: VITE_TOKEN_SERVER_URL aponta para ${tokenServer}`);
  console.error('Publicar assim gera um site que so funciona na sua maquina.');
  console.error('Aponte para o token-server publicado antes de rodar.\n');
  process.exit(1);
}

if (!env.CLOUDFLARE_API_TOKEN) faltando.push('CLOUDFLARE_API_TOKEN');
if (!env.CLOUDFLARE_ACCOUNT_ID) faltando.push('CLOUDFLARE_ACCOUNT_ID');

if (faltando.length > 0) {
  console.error('\nFaltam variaveis para publicar:\n');
  for (const f of faltando) console.error(`  - ${f}`);
  console.error('\nCrie o token em: Cloudflare > My Profile > API Tokens.');
  console.error('Permissao minima: Account > Cloudflare Pages > Edit.');
  console.error('O account id aparece na URL do painel do Cloudflare.\n');
  process.exit(1);
}

console.log(`Buildando o viewer apontando para ${tokenServer}`);
await run('pnpm', ['--filter', '@game-share/viewer', 'build'], env);

console.log(`\nPublicando em Cloudflare Pages (projeto ${PROJETO})`);
await run(
  'npx',
  [
    '--yes',
    'wrangler@latest',
    'pages',
    'deploy',
    'apps/viewer/dist',
    `--project-name=${PROJETO}`,
    '--branch=main',
    '--commit-dirty=true',
  ],
  env,
);
