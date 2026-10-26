import { defineConfig } from '@playwright/test';

const base = process.env.VMGS_STACK_URL ?? 'https://localhost:18443';

// A look at a stack that is already running, as the owner sees it in a browser (phase U5c): the real web image (Caddy with the
// built web app), the real API and worker, the real feed. It starts nothing. It only reads (nothing is changed), so it is as safe on the
// VM as on a PC. Needs the owner's login in the environment: VMGS_STACK_USER (default `owner`), VMGS_STACK_PASS and, when the
// 2-step login is on, VMGS_STACK_CODE (the code of the moment). VMGS_STACK_INSECURE=1 trusts the certificate of the local drill
// (deploy/drills/local-web.yml: Caddy makes its own for `localhost`); on the VM the certificate is a real one. No screenshots.
export default defineConfig({
  testDir: './stack',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: base,
    ignoreHTTPSErrors: process.env.VMGS_STACK_INSECURE === '1',
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
});
