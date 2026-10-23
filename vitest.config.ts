import { defineConfig } from 'vitest/config';

// The web app has its own project (jsdom) in apps/web/vitest.config.ts.
// Integration tests (*.int.test.ts, need Docker) get their own project in B2.
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
      'apps/web',
    ],
  },
});
