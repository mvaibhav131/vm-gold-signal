import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApiError, type ApiClient } from '../api/client';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from '../mocks/mockClient';
import { memoryStorage, renderApp } from '../test-utils';
import { ME_KEY } from './RequireAuth';
import { endSessionIfLost, forgetPrivateData, isSessionLost } from './sessionLoss';

const gone = new ApiError(401, 'unauthenticated', 'There is no valid session.');

describe('isSessionLost', () => {
  it('is the 401 of a session that is gone, and nothing else: a refused login is also a 401', () => {
    expect(isSessionLost(gone)).toBe(true);
    expect(isSessionLost(new ApiError(401, 'invalid_credentials', 'Login failed.'))).toBe(false);
    expect(isSessionLost(new ApiError(403, 'csrf_rejected', 'No.'))).toBe(false);
    expect(isSessionLost(new ApiError(403, 'unauthenticated', 'No.'))).toBe(false);
    expect(isSessionLost(new ApiError(404, 'not_found', 'No.'))).toBe(false);
    expect(isSessionLost(new ApiError(0, 'network_error', 'Down.'))).toBe(false);
    expect(isSessionLost(new Error('unauthenticated'))).toBe(false);
    expect(isSessionLost(null)).toBe(false);
  });
});

describe('endSessionIfLost and forgetPrivateData', () => {
  it('tells the app there is no owner when the session is gone, and leaves it alone for any other error', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ME_KEY, { username: 'owner' });
    endSessionIfLost(queryClient, new ApiError(500, 'internal_error', 'Boom.'));
    endSessionIfLost(queryClient, new ApiError(401, 'invalid_credentials', 'Login failed.'));
    expect(queryClient.getQueryData(ME_KEY)).toEqual({ username: 'owner' });
    endSessionIfLost(queryClient, gone);
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
  });

  it('forgets everything that was loaded with the earlier session, and keeps the answer about the session', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ME_KEY, null);
    queryClient.setQueryData(['signals', 'open'], { items: [] });
    queryClient.setQueryData(['snapshot'], { bid: 1 });
    forgetPrivateData(queryClient);
    expect(queryClient.getQueryData(ME_KEY)).toBeNull();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([ME_KEY]);
  });
});

describe('a session that ends while a screen is open', () => {
  it('sends the visitor to the login at the first request that is refused, and not before', async () => {
    const mock = createMockClient({
      storage: memoryStorage(),
      latencyMs: 0,
      quoteIntervalMs: 600_000,
      signalUpdateIntervalMs: 600_000,
    });
    await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
    let ended = false;
    const client: ApiClient = {
      ...mock,
      getSignals: (query) => (ended ? Promise.reject(gone) : mock.getSignals(query)),
    };
    const { router } = renderApp({ client, route: '/' });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');

    ended = true; // the owner revoked this session from another device
    await router.navigate('/signals');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows nothing of the earlier session after a new login, until the answers for the new one arrive', async () => {
    const user = userEvent.setup();
    const mock = createMockClient({
      storage: memoryStorage(),
      latencyMs: 0,
      quoteIntervalMs: 600_000,
      signalUpdateIntervalMs: 600_000,
      scenario: 'two-open',
    });
    await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
    let ended = false;
    let held = false;
    const client: ApiClient = {
      ...mock,
      me: () => (ended ? Promise.resolve(null) : mock.me()),
      login: async (request) => {
        ended = false;
        await mock.login(request);
      },
      getSignals: (query) => (ended ? Promise.reject(gone) : mock.getSignals(query)),
      getOpenSignals: () => (held ? new Promise(() => undefined) : mock.getOpenSignals()),
    };
    const { router } = renderApp({ client, route: '/' });
    expect((await screen.findAllByTestId(/^signal-card-/)).length).toBeGreaterThan(0);

    ended = true;
    await router.navigate('/signals');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });

    held = true; // the open signals of the new session have not arrived yet
    await user.type(await screen.findByLabelText(/^username/i), MOCK_USERNAME);
    await user.type(screen.getByLabelText(/^password/i), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    // a login goes back to the screen that was asked for
    expect(await screen.findByRole('heading', { name: 'Signals', level: 1 })).toBeInTheDocument();
    await router.navigate('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^signal-card-/)).toHaveLength(0);
  });
});
