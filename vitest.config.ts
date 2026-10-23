import { defineConfig } from 'vitest/config';

// Integration tests (*.int.test.ts, need Docker) get their own project in B2.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages,tools}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
    ],
  },
});
