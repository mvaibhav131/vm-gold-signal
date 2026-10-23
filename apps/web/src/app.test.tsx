import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
import { memoryStorage, renderApp } from './test-utils';

async function logIn(user: ReturnType<typeof userEvent.setup>, password = MOCK_PASSWORD) {
  await user.type(await screen.findByLabelText(/^username/i), MOCK_USERNAME);
  await user.type(screen.getByLabelText(/^password/i), password);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('login (scenario E1)', () => {
  it('sends a visitor without a session from a private route to /login', async () => {
    const { router } = renderApp({ route: '/signals' });
    expect(
      await screen.findByRole('heading', { name: 'VM Gold Signal', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('has no sign-up and no forgot-password link', async () => {
    renderApp({ route: '/login' });
    await screen.findByRole('button', { name: 'Log in' });
    expect(
      screen.queryByRole('link', { name: /sign ?up|register|create account|forgot/i }),
    ).toBeNull();
  });

  it('shows one generic error for a wrong password and stays on /login', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ route: '/login' });
    await logIn(user, 'wrong-password');
    const error = await screen.findByTestId('login-error');
    expect(error).toHaveTextContent('Login failed. Check your details and try again.');
    expect(error).not.toHaveTextContent(/password is|username is|no such user|wrong password/i);
    expect(router.state.location.pathname).toBe('/login');
  });

  it('asks for the missing fields before calling the API', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/login' });
    await user.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Enter your username')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(screen.queryByTestId('login-error')).toBeNull();
  });

  it('rejects a malformed authenticator code', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/login' });
    await user.type(await screen.findByLabelText(/^username/i), MOCK_USERNAME);
    await user.type(screen.getByLabelText(/^password/i), MOCK_PASSWORD);
    await user.type(screen.getByLabelText(/authenticator code/i), '12ab');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('The code has 6 digits')).toBeInTheDocument();
  });

  it('lands on the dashboard after a correct login, and back on /login after logout', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ route: '/login' });
    await logIn(user);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('returns to the page that was asked for before the login', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ route: '/analytics' });
    await logIn(user);
    expect(await screen.findByRole('heading', { name: 'Analytics', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/analytics');
  });

  it('shows the preview credentials only because this is the mock', async () => {
    renderApp({ route: '/login' });
    expect(await screen.findByTestId('login-preview-hint')).toHaveTextContent(MOCK_USERNAME);
  });
});

describe('status bar (scenario E2)', () => {
  async function openDashboard() {
    const user = userEvent.setup();
    renderApp({ route: '/login' });
    await logIn(user);
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    return user;
  }

  it('shows price, spread, feed, session, regime, engine, mode and strategy status as text', async () => {
    await openDashboard();
    const bar = screen.getByRole('region', { name: 'Market status' });
    await waitFor(() => {
      expect(within(bar).getByTestId('status-session')).toHaveTextContent('LONDON');
    });
    expect(within(bar).getByTestId('status-price')).toHaveTextContent(
      /^\d{4}\.\d{2} \(bid \d{4}\.\d{2} \/ ask \d{4}\.\d{2}\)$/,
    );
    expect(within(bar).getByTestId('status-spread')).toHaveTextContent(/^\d\.\d{2}$/);
    expect(within(bar).getByTestId('status-freshness')).toHaveTextContent(/^FRESH \d\.\d s$/);
    expect(within(bar).getByTestId('status-regime')).toHaveTextContent('TREND UP');
    expect(within(bar).getByTestId('status-engine')).toHaveTextContent('RUNNING');
  });

  it('always shows the SIMULATED badge and FORWARD-TEST while nothing is validated', async () => {
    await openDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('status-mode')).toHaveTextContent('SIMULATED');
    });
    await waitFor(() => {
      expect(screen.getByTestId('status-strategy')).toHaveTextContent('FORWARD-TEST');
    });
  });
});

describe('navigation', () => {
  it('opens every main screen from the navigation and marks the current one', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ route: '/login' });
    await logIn(user);
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });

    for (const [name, path] of [
      ['Signals', '/signals'],
      ['Analytics', '/analytics'],
      ['News', '/news'],
      ['System', '/system'],
      ['Dashboard', '/'],
    ] as const) {
      const link = screen.getAllByRole('link', { name })[0];
      if (link === undefined) throw new Error(`no ${name} link`);
      await user.click(link);
      expect(await screen.findByRole('heading', { name, level: 1 })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(path);
      for (const same of screen.getAllByRole('link', { name })) {
        expect(same).toHaveAttribute('aria-current', 'page');
      }
    }
  });

  it('shows a not-found page inside the frame for an unknown path', async () => {
    const client = createMockClient({
      storage: memoryStorage(),
      latencyMs: 0,
      quoteIntervalMs: 60_000,
    });
    await client.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
    renderApp({ client, route: '/nope' });
    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Market status' })).toBeInTheDocument();
  });

  it('opens a signal detail page for an id', async () => {
    const client = createMockClient({
      storage: memoryStorage(),
      latencyMs: 0,
      quoteIntervalMs: 60_000,
    });
    await client.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
    renderApp({ client, route: '/signals/S-0042' });
    expect(
      await screen.findByRole('heading', { name: 'Signal detail', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('S-0042')).toBeInTheDocument();
  });
});
