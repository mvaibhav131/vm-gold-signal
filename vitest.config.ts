import { defineConfig } from 'vitest/config';

// The web app has its own project (jsdom) in apps/web/vitest.config.ts.
// Integration tests (*.int.test.ts) run against a real Postgres 17 started with Testcontainers,
// so they need Docker. They run one file at a time and every file gets its own database.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{packages,tools}/*/src/**/*.test.ts', 'apps/{api,worker}/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'int',
          environment: 'node',
          include: [
            '{packages,tools}/*/src/**/*.int.test.ts',
            'apps/{api,worker}/src/**/*.int.test.ts',
          ],
          globalSetup: ['packages/db/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 240_000,
        },
      },
      'apps/web',
    ],
  },
});
