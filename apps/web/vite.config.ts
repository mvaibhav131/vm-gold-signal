import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, target: 'es2022' },
  // `VITE_DATA_SOURCE=live pnpm web:dev` talks to an API on this PC (`pnpm api:start`, with SITE_ORIGIN=http://localhost:5173
  // in its environment): the browser's Origin and Host go through unchanged, so the API's origin check sees the page.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
