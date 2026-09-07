import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // .env unico na raiz do monorepo
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // appType 'spa' (padrao) ja faz fallback de /watch/XXXX-XXXX para index.html
  },
  preview: { port: 5174, strictPort: true },
});
