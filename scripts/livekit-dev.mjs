#!/usr/bin/env node
/**
 * Sobe um LiveKit local para desenvolvimento, sem Docker.
 * Baixa o binario oficial na primeira execucao e guarda em .livekit/.
 *
 * As credenciais vem do .env da raiz (LIVEKIT_API_KEY / LIVEKIT_API_SECRET),
 * entao o token-server e este servidor usam exatamente o mesmo par.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.livekit');
const VERSION = 'v1.13.6';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

const PLATFORM = {
  win32: { asset: `livekit_${VERSION.slice(1)}_windows_${ARCH}.zip`, bin: 'livekit-server.exe' },
  darwin: { asset: `livekit_${VERSION.slice(1)}_darwin_${ARCH}.zip`, bin: 'livekit-server' },
  linux: { asset: `livekit_${VERSION.slice(1)}_linux_${ARCH}.tar.gz`, bin: 'livekit-server' },
}[process.platform];

if (!PLATFORM) {
  console.error(`Plataforma nao suportada por este script: ${process.platform}`);
  console.error('Use LiveKit Cloud e ajuste LIVEKIT_* no .env.');
  process.exit(1);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function readEnv() {
  return readFile(path.join(ROOT, '.env'), 'utf8')
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
}

async function download() {
  const url = `https://github.com/livekit/livekit/releases/download/${VERSION}/${PLATFORM.asset}`;
  console.log(`Baixando LiveKit ${VERSION}…\n  ${url}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`);

  await mkdir(DIR, { recursive: true });
  const archive = path.join(DIR, PLATFORM.asset);
  await pipeline(res.body, createWriteStream(archive));

  if (archive.endsWith('.zip')) {
    // tar do Windows 10+ le zip; evita dependencia extra
    await run('tar', ['-xf', archive, '-C', DIR], { stdio: 'inherit' });
  } else {
    await run('tar', ['-xzf', archive, '-C', DIR], { stdio: 'inherit' });
  }
  await rm(archive, { force: true });

  const bin = path.join(DIR, PLATFORM.bin);
  if (process.platform !== 'win32') await chmod(bin, 0o755);
  return bin;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: process.platform === 'win32', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} saiu com ${code}`))));
  });
}

const bin = path.join(DIR, PLATFORM.bin);
if (!(await exists(bin))) await download();

const env = await readEnv();
const key = env.LIVEKIT_API_KEY;
const secret = env.LIVEKIT_API_SECRET;

if (!key || !secret) {
  console.error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET ausentes no .env da raiz.');
  console.error('Copie .env.example para .env antes de rodar.');
  process.exit(1);
}
if (secret.length < 32) {
  console.error('LIVEKIT_API_SECRET precisa ter pelo menos 32 caracteres.');
  process.exit(1);
}

console.log(`LiveKit em ws://127.0.0.1:7880 (key=${key})`);
const child = spawn(bin, ['--dev', '--bind', '0.0.0.0', '--keys', `${key}: ${secret}`], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
