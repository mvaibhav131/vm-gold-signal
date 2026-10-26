import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `--mode live` is a build for the API of the server (phase U5): the data source is fixed here, so that no environment
// file is needed and the mock data stay out of the bundle. Without it the data source is `VITE_DATA_SOURCE` (mock).
const apiProxy = { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } };

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...(mode === 'live'
    ? { define: { 'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('live') } }
    : {}),
  build: { sourcemap: false, target: 'es2022' },
  // `VITE_DATA_SOURCE=live pnpm web:dev` talks to an API on this PC (`pnpm api:start`, with SITE_ORIGIN=http://localhost:5173
  // in its environment): the browser's Origin and Host go through unchanged, so the API's origin check sees the page.
  server: { proxy: apiProxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: apiProxy },
}));
