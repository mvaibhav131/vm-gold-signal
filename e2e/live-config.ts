import { defineConfig } from '@playwright/test';

const web = 'http://127.0.0.1:4174';
const api = 'http://127.0.0.1:3000';

export type LiveWorld = 'seeded' | 'fresh';

/**
 * The scenarios against the real API (phase U5): the web app built with `--mode live` (pnpm web:build:live) in front of the whole
 * API on a real Postgres and a simulated worker (apps/api/src/liveStack.int.test.ts). Two worlds, each with its own run of the
 * stack: `seeded` (months of signals, a calendar, headlines, incidents) and `fresh` (the first hour of a new VM: nothing yet).
 * One worker: the scenarios of a world share its one stack and change its state. DOM and accessibility assertions only: no
 * screenshots.
 */
export function liveConfig(world: LiveWorld) {
  return defineConfig({
    testDir: './live',
    // the files of a world run in the order of their names: the ones that only read first, those that change the stack after
    testMatch: world === 'seeded' ? '**/seeded-*.spec.ts' : '**/fresh-*.spec.ts',
    fullyParallel: false,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
    use: { baseURL: web, screenshot: 'off', video: 'off', trace: 'off' },
    projects: [
      {
        name: 'desktop',
        use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
      },
    ],
    webServer: [
      {
        command: 'pnpm --filter @vmgs/web exec vite preview --outDir dist-live --port 4174',
        url: web,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
      {
        command: 'pnpm exec vitest run --project int apps/api/src/liveStack.int.test.ts',
        cwd: '..',
        env: {
          VMGS_LIVE_STACK: '1',
          VMGS_LIVE_SITE: web,
          VMGS_LIVE_PORT: '3000',
          VMGS_LIVE_CONTROL_PORT: '3001',
          VMGS_LIVE_WORLD: world,
        },
        url: `${api}/api/v1/health/live`,
        // a stack that is left over from another world would answer with the wrong data
        reuseExistingServer: false,
        timeout: 240_000,
      },
    ],
  });
}
