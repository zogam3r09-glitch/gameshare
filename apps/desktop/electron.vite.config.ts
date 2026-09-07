import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/** .env unico na raiz do monorepo. Somente vars VITE_* chegam ao bundle. */
const envDir = resolve(__dirname, '../..');

/** main e preload precisam ser CJS para funcionar com `sandbox: true`. */
const cjs = { build: { rollupOptions: { output: { format: 'cjs' as const } } } };

export default defineConfig({
  main: {
    envDir,
    // o pacote do workspace e TypeScript cru: precisa ser bundlado, nao externalizado
    plugins: [externalizeDepsPlugin({ exclude: ['@game-share/shared'] })],
    ...cjs,
  },
  preload: {
    envDir,
    // o pacote do workspace e TypeScript cru: precisa ser bundlado, nao externalizado
    plugins: [externalizeDepsPlugin({ exclude: ['@game-share/shared'] })],
    ...cjs,
  },
  renderer: {
    envDir,
    plugins: [react()],
    server: { port: 5173, strictPort: true },
  },
});
