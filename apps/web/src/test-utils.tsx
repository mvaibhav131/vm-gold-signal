import { render } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import type { ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { createMockClient } from './mocks/mockClient';
import { appRoutes } from './routes';

export function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

/** Renders the whole app on an in-memory router, with a mock client that answers at once. */
export function renderApp(options: { client?: ApiClient; route?: string } = {}) {
  const client =
    options.client ??
    createMockClient({ storage: memoryStorage(), latencyMs: 0, quoteIntervalMs: 60_000 });
  const router = createMemoryRouter(appRoutes, { initialEntries: [options.route ?? '/'] });
  render(
    <AppProviders client={client}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { client, router };
}
