import { act, render } from '@testing-library/react';
import type { SseEvent } from '@vmgs/contracts';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import type { ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
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

/**
 * Renders the app on a route with a mock client that is already logged in, in one preview state.
 * `emit` pushes a stream event into the app; `now` lets a test move the clock of the simulated system.
 */
export async function renderLoggedIn(
  route: string,
  options: { scenario?: string; now?: () => Date } = {},
) {
  const mock = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 600_000,
    signalUpdateIntervalMs: 600_000,
    scenario: options.scenario ?? 'two-open',
    ...(options.now ? { now: options.now } : {}),
  });
  await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
  let listener: ((event: SseEvent) => void) | undefined;
  const client: ApiClient = {
    ...mock,
    subscribe(next) {
      listener = next;
      return mock.subscribe(next);
    },
  };
  const { router } = renderApp({ client, route });
  return {
    client,
    router,
    emit: (event: SseEvent) => {
      act(() => {
        listener?.(event);
      });
    },
  };
}
