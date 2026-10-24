import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FeedIncident, SystemStorage } from '@vmgs/contracts';
import { STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { STRATEGY_LABELS } from './format/signal';
import { MOCK_PASSWORD, MOCK_TOTP_CODE, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
import { ALERTS_ON } from './mocks/preferences';
import { IncidentsTable } from './system/HealthTab';
import { BudgetGauge, StorageView } from './system/StorageTab';
import { memoryStorage, renderApp } from './test-utils';

type Override = (mock: ApiClient) => Partial<ApiClient>;

/** Opens a route in one preview state, logged in. The clock is the real one, as the page's own clock is. */
async function open(
  route: string,
  { scenario = 'two-open', override = () => ({}) }: { scenario?: string; override?: Override } = {},
) {
  const mock = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 600_000,
    signalUpdateIntervalMs: 600_000,
    scenario,
  });
  await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
  const client: ApiClient = { ...mock, ...override(mock) };
  const { router } = renderApp({ client, route });
  await screen.findByRole('tab', { name: 'Health' });
  return { client, mock, router, user: userEvent.setup() };
}

const rejected = () => Promise.reject(new ApiError(500, 'server_error', 'The server failed.'));

async function choose(user: ReturnType<typeof userEvent.setup>, testId: string, option: string) {
  const input = screen.getByTestId(testId);
  await user.click(input);
  const listId = input.getAttribute('aria-controls');
  const list = listId === null ? null : document.getElementById(listId);
  if (list === null) throw new Error(`the menu of ${testId} did not open`);
  await user.click(await within(list).findByRole('option', { name: option, hidden: true }));
}

const row = (key: string) => screen.getByTestId(`health-${key}`);

describe('the system screen (scenarios E12 and E13)', () => {
  it('has a heading, the six tabs in order, and the health tab first', async () => {
    await open('/system');
    expect(screen.getByRole('heading', { name: 'System', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Health',
      'Storage',
      'Strategies',
      'Alerts',
      'Display',
      'Security',
    ]);
    expect(screen.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
    expect(document.title).toContain('System');
    expect(await screen.findByTestId('health-summary')).toBeInTheDocument();
  });

  it('opens the tab of the address, and a tab switch changes the address', async () => {
    const { router, user } = await open('/system?tab=alerts');
    expect(screen.getByRole('tab', { name: 'Alerts' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('alerts-telegram-switch')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Storage' }));
    expect(await screen.findByTestId('storage-db-size')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=storage');
    await user.click(screen.getByRole('tab', { name: 'Health' }));
    expect(await screen.findByTestId('health-summary')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });

  it('opens the health tab for a tab it does not know', async () => {
    await open('/system?tab=weather');
    expect(screen.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the health tab', () => {
  it('lists the nine checks in order, each with a value in words, and says that all are fine', async () => {
    await open('/system');
    expect(await screen.findByTestId('health-summary')).toHaveTextContent('All checks are fine.');
    expect(
      within(screen.getByTestId('health-checks'))
        .getAllByTestId(/^health-[a-z]+$/)
        .map((checkRow) => checkRow.getAttribute('data-testid')),
    ).toEqual([
      'health-feed',
      'health-ticks',
      'health-worker',
      'health-loop',
      'health-db',
      'health-telegram',
      'health-clock',
      'health-backup',
      'health-maintenance',
    ]);
    expect(screen.getByTestId('health-feed-value')).toHaveTextContent(
      /^Live, newest tick \d\.\d s ago$/,
    );
    expect(screen.getByTestId('health-ticks-value')).toHaveTextContent('2.4 per second');
    expect(screen.getByTestId('health-worker-value')).toHaveTextContent(/^Heartbeat \d+ s ago$/);
    expect(screen.getByTestId('health-loop-value')).toHaveTextContent('12 ms');
    expect(screen.getByTestId('health-db-value')).toHaveTextContent('Reachable');
    expect(screen.getByTestId('health-telegram-value')).toHaveTextContent(
      /^Last send 4\d min ago$/,
    );
    expect(screen.getByTestId('health-clock-value')).toHaveTextContent(
      '+40 ms against the feed time',
    );
    expect(screen.getByTestId('health-backup-value')).toHaveTextContent(
      /^(8 h 59 min|9 h( \d+ min)?) ago$/,
    );
    expect(screen.getByTestId('health-maintenance-value')).toHaveTextContent(
      /^(10 h 59 min|11 h( \d+ min)?) ago$/,
    );
    for (const key of ['feed', 'worker', 'loop', 'db', 'telegram', 'clock', 'backup']) {
      expect(row(key), key).toHaveTextContent('OK');
    }
    // the ticks per second only inform: no level, a dash
    expect(row('ticks')).not.toHaveTextContent(/OK|DEGRADED|DOWN|UNKNOWN/);
  });

  it('shows the latency of each step with its measurements', async () => {
    await open('/system');
    const table = await screen.findByTestId('health-latency');
    expect(within(table).getAllByTestId(/^latency-/)).toHaveLength(4);
    expect(screen.getByTestId('latency-feedLag')).toHaveTextContent('180 ms');
    expect(screen.getByTestId('latency-feedLag')).toHaveTextContent('420 ms');
    expect(screen.getByTestId('latency-feedLag')).toHaveTextContent('14300');
    expect(screen.getByTestId('latency-notifyDispatch')).toHaveTextContent('650 ms');
    expect(screen.getByTestId('latency-notifyDispatch')).toHaveTextContent('1900 ms');
  });

  it('lists the feed incidents newest first, with how long each lasted, none of them ongoing', async () => {
    await open('/system');
    const table = await screen.findByTestId('health-incidents');
    const rows = within(table).getAllByTestId(/^incident-/);
    expect(rows).toHaveLength(9);
    expect(rows.map((incidentRow) => incidentRow.getAttribute('data-testid'))).toEqual(
      ['9', '8', '7', '6', '5', '4', '3', '2', '1'].map((id) => `incident-${id}`),
    );
    expect(rows[0]).toHaveTextContent('Gap in the data');
    expect(rows[0]).toHaveTextContent('4 min');
    expect(table).not.toHaveTextContent('Ongoing');
  });

  it('STALE: the feed row is degraded and the incident that is still open comes first', async () => {
    await open('/system', { scenario: 'stale' });
    await waitFor(() => {
      expect(screen.getByTestId('health-feed-value')).toHaveTextContent(
        /^Stale, newest tick 18 s ago$/,
      );
    });
    expect(row('feed')).toHaveTextContent('DEGRADED');
    expect(screen.getByTestId('health-summary')).toHaveTextContent('1 check needs attention.');
    const first = within(await screen.findByTestId('health-incidents')).getAllByTestId(
      /^incident-/,
    )[0];
    expect(first).toHaveTextContent('Stale feed');
    expect(first).toHaveTextContent(/Ongoing, /);
    expect(first).toHaveTextContent('No tick for 18 s, new signals are blocked');
  });

  it('DISCONNECTED: the feed row is down, the ticks per second are not known, the incident is open', async () => {
    await open('/system', { scenario: 'disconnected' });
    await waitFor(() => {
      expect(screen.getByTestId('health-feed-value')).toHaveTextContent(
        /^Disconnected, last tick .+ ago$/,
      );
    });
    expect(row('feed')).toHaveTextContent('DOWN');
    expect(screen.getByTestId('health-ticks-value')).toHaveTextContent('Not known');
    const first = within(await screen.findByTestId('health-incidents')).getAllByTestId(
      /^incident-/,
    )[0];
    expect(first).toHaveTextContent('Disconnect');
    expect(first).toHaveTextContent('Connection lost, reconnecting');
    expect(first).toHaveTextContent('Ongoing');
  });

  it('MARKET CLOSED: a feed without ticks is not a fault', async () => {
    await open('/system', { scenario: 'market-closed' });
    await waitFor(() => {
      expect(screen.getByTestId('health-feed-value')).toHaveTextContent(
        'Market closed, no ticks expected',
      );
    });
    expect(row('feed')).toHaveTextContent('OK');
    expect(screen.getByTestId('health-summary')).toHaveTextContent('All checks are fine.');
  });

  it('SYSTEM WARNING: four checks need attention, each says what is wrong, and a skew incident is open', async () => {
    await open('/system', { scenario: 'system-warning' });
    expect(await screen.findByTestId('health-summary')).toHaveTextContent(
      '4 checks need attention.',
    );
    expect(screen.getByTestId('health-telegram-value')).toHaveTextContent(
      /^Telegram answered 502 Bad Gateway; retrying in 45 s\. Last send .+ ago$/,
    );
    expect(screen.getByTestId('health-loop-value')).toHaveTextContent('180 ms');
    expect(screen.getByTestId('health-clock-value')).toHaveTextContent(
      '+3400 ms against the feed time',
    );
    expect(screen.getByTestId('health-backup-value')).toHaveTextContent(/^1 d 1[67] h ago$/);
    for (const key of ['telegram', 'loop', 'clock', 'backup']) {
      expect(row(key), key).toHaveTextContent('DEGRADED');
    }
    for (const key of ['feed', 'worker', 'db', 'maintenance']) {
      expect(row(key), key).toHaveTextContent('OK');
    }
    const first = within(await screen.findByTestId('health-incidents')).getAllByTestId(
      /^incident-/,
    )[0];
    expect(first).toHaveTextContent('Clock skew');
    expect(first).toHaveTextContent('Ongoing');
    expect(screen.getByTestId('latency-notifyDispatch')).toHaveTextContent('4200 ms');
  });

  it('says UNKNOWN, never a guess, for what the worker has not reported yet', async () => {
    await open('/system', {
      override: (mock) => ({
        getSystemHealth: async () => ({
          ...(await mock.getSystemHealth()),
          feedAgeMs: null,
          ticksPerSecond: null,
          workerHeartbeatAt: null,
          eventLoopLagMs: null,
          telegram: { lastSendAt: null, lastError: null },
          clockSkewMs: null,
          lastBackupAt: null,
          lastMaintenanceAt: null,
        }),
      }),
    });
    expect(await screen.findByTestId('health-summary')).toHaveTextContent(
      '7 checks are not known yet.',
    );
    expect(screen.getByTestId('health-worker-value')).toHaveTextContent(
      'No heartbeat received yet',
    );
    expect(screen.getByTestId('health-telegram-value')).toHaveTextContent('No message sent yet');
    expect(screen.getByTestId('health-backup-value')).toHaveTextContent('No backup yet');
    expect(screen.getByTestId('health-maintenance-value')).toHaveTextContent('No run yet');
    expect(row('worker')).toHaveTextContent('UNKNOWN');
    expect(row('db')).toHaveTextContent('OK');
  });

  it('says that the health could not be loaded, and loads it on a retry', async () => {
    let calls = 0;
    const { user } = await open('/system', {
      override: (mock) => ({
        getSystemHealth: () => {
          calls += 1;
          return calls === 1 ? rejected() : mock.getSystemHealth();
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the health');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('health-summary')).toBeInTheDocument();
  });

  describe('the engine card', () => {
    const watchPause = () => {
      const pause = vi.fn<ApiClient['pauseEngine']>();
      const override: Override = (mock) => {
        pause.mockImplementation((request) => mock.pauseEngine(request));
        return { pauseEngine: pause };
      };
      return { pause, override };
    };

    it('asks first, pauses for the time that was chosen, and resumes', async () => {
      const { pause, override } = watchPause();
      const { user } = await open('/system', { override });
      expect(await screen.findByTestId('health-engine-status')).toHaveTextContent('RUNNING');
      expect(screen.queryByTestId('health-resume')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('health-pause'));
      const dialog = await screen.findByTestId('pause-dialog');
      expect(pause).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('radio', { name: '4 hours' }));
      await user.click(screen.getByTestId('pause-confirm'));
      await waitFor(() => {
        expect(screen.getByTestId('health-engine-status')).toHaveTextContent('PAUSED');
      });
      expect(pause).toHaveBeenCalledExactlyOnceWith({ minutes: 240 });
      expect(screen.queryByTestId('pause-dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('health-engine')).toHaveTextContent('Paused since');
      expect(screen.queryByTestId('health-pause')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('health-resume'));
      await waitFor(() => {
        expect(screen.getByTestId('health-engine-status')).toHaveTextContent('RUNNING');
      });
      expect(screen.getByTestId('health-pause')).toBeInTheDocument();
    });

    it('pauses until the owner resumes, with no time', async () => {
      const { pause, override } = watchPause();
      const { user } = await open('/system', { override });
      await user.click(await screen.findByTestId('health-pause'));
      const dialog = await screen.findByTestId('pause-dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Until I resume' }));
      await user.click(screen.getByTestId('pause-confirm'));
      await waitFor(() => {
        expect(screen.getByTestId('health-engine-status')).toHaveTextContent('PAUSED');
      });
      expect(pause).toHaveBeenCalledExactlyOnceWith({});
    });

    it('does nothing when the question is cancelled', async () => {
      const { pause, override } = watchPause();
      const { user } = await open('/system', { override });
      await user.click(await screen.findByTestId('health-pause'));
      const dialog = await screen.findByTestId('pause-dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByTestId('pause-dialog')).not.toBeInTheDocument();
      });
      expect(pause).not.toHaveBeenCalled();
      expect(screen.getByTestId('health-engine-status')).toHaveTextContent('RUNNING');
    });

    it('shows the new engine state from the answer of the API, without help from the stream', async () => {
      const { user } = await open('/system', {
        override: () => ({ subscribe: () => () => undefined }),
      });
      await user.click(await screen.findByTestId('health-pause'));
      await user.click(await screen.findByTestId('pause-confirm'));
      // the status is polled every 5 s: a short wait shows that the pause itself reloads it
      await waitFor(
        () => {
          expect(screen.getByTestId('health-engine-status')).toHaveTextContent('PAUSED');
        },
        { timeout: 1500 },
      );
      await user.click(screen.getByTestId('health-resume'));
      await waitFor(
        () => {
          expect(screen.getByTestId('health-engine-status')).toHaveTextContent('RUNNING');
        },
        { timeout: 1500 },
      );
    });

    it('starts paused in the paused preview state, with Resume and no Pause', async () => {
      await open('/system', { scenario: 'paused' });
      await waitFor(() => {
        expect(screen.getByTestId('health-engine-status')).toHaveTextContent('PAUSED');
      });
      expect(screen.getByTestId('health-resume')).toBeInTheDocument();
      expect(screen.queryByTestId('health-pause')).not.toBeInTheDocument();
      expect(screen.getByTestId('health-engine')).toHaveTextContent('Paused since');
    });
  });

  describe('the incidents as a view', () => {
    const NOW = Date.parse('2026-10-23T12:00:00Z');
    const incident = (change: Partial<FeedIncident>): FeedIncident => ({
      id: 1,
      kind: 'DISCONNECT',
      startedAt: new Date(NOW - 3_600_000).toISOString(),
      endedAt: new Date(NOW - 3_600_000 + 14_000).toISOString(),
      detail: 'Connection lost, reconnected after 14 s',
      ...change,
    });
    const show = (incidents: readonly FeedIncident[]) =>
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <IncidentsTable incidents={incidents} nowMs={NOW} />
        </AppProviders>,
      );

    it('says that no incident was recorded, when there is none', () => {
      show([]);
      expect(screen.getByTestId('health-incidents')).toHaveTextContent(
        'No feed incident has been recorded.',
      );
    });

    it('writes the length of a closed incident, and the time so far of an open one', () => {
      show([
        incident({ id: 2, endedAt: null, startedAt: new Date(NOW - 5_400_000).toISOString() }),
        incident({ id: 1 }),
      ]);
      expect(screen.getByTestId('incident-2')).toHaveTextContent('Ongoing, 1 h 30 min');
      expect(screen.getByTestId('incident-1')).toHaveTextContent('14 s');
      expect(screen.getByTestId('incident-1')).not.toHaveTextContent('Ongoing');
    });

    it('names every kind of incident in words', () => {
      const kinds = [
        ['DISCONNECT', 'Disconnect'],
        ['STALE', 'Stale feed'],
        ['GAP', 'Gap in the data'],
        ['CLOCK_SKEW', 'Clock skew'],
        ['SPREAD_SPIKE', 'Spread spike'],
        ['MARKET_STATE', 'Market state'],
      ] as const;
      show(kinds.map(([kind], index) => incident({ id: index + 1, kind })));
      for (const [index, [, label]] of kinds.entries()) {
        expect(screen.getByTestId(`incident-${String(index + 1)}`)).toHaveTextContent(label);
      }
    });
  });
});

describe('the storage tab', () => {
  it('shows the size, the budget, the tables biggest first, the retention rules and the last runs', async () => {
    await open('/system?tab=storage');
    expect(await screen.findByTestId('storage-db-size')).toHaveTextContent('1.14 GB');
    const budget = screen.getByTestId('storage-budget');
    expect(budget).toHaveTextContent('11% of the budget');
    expect(screen.getByTestId('storage-budget-level')).toHaveTextContent('Within the budget');
    expect(screen.queryByTestId('storage-warning')).not.toBeInTheDocument();
    expect(within(budget).getByRole('progressbar')).toHaveAccessibleName(
      'Database size: 11% of the budget',
    );

    const tables = within(screen.getByTestId('storage-tables')).getAllByTestId(/^storage-table-/);
    expect(tables.map((tableRow) => tableRow.getAttribute('data-testid'))).toEqual([
      'storage-table-ticks',
      'storage-table-candles_1m',
      'storage-table-signal_feature_snapshots',
      'storage-table-rejections',
      'storage-table-news_items',
      'storage-table-notification_outbox',
      'storage-table-candles_5m_and_higher',
      'storage-table-signals_events_and_outcomes',
    ]);
    expect(tables[0]).toHaveTextContent('612 MB');
    expect(tables[6]).toHaveTextContent('6.0 MB');
    expect(tables[7]).toHaveTextContent('3.0 MB');

    const retention = screen.getByTestId('storage-retention');
    expect(within(retention).getAllByRole('row')).toHaveLength(15);
    expect(retention).toHaveTextContent('Raw ticks (XAUUSD)');
    expect(retention).toHaveTextContent('14 days; daily partitions are dropped');
    expect(retention).toHaveTextContent('Signals, events, outcomes and reviews');
    expect(retention).toHaveTextContent('Kept forever');

    expect(screen.getByTestId('storage-maintenance')).toHaveTextContent(
      /Last maintenance run: retention, finished .+ \((10 h 59 min|11 h( \d+ min)?) ago\), 1,204,331 rows deleted\./,
    );
    expect(screen.getByTestId('storage-backup')).toHaveTextContent(
      /Last backup: .+ \((8 h 59 min|9 h( \d+ min)?) ago\)\./,
    );
  });

  it('SYSTEM WARNING: 82% of the budget says that it is getting full, and what the job does about it', async () => {
    await open('/system?tab=storage', { scenario: 'system-warning' });
    expect(await screen.findByTestId('storage-db-size')).toHaveTextContent('8.80 GB');
    expect(screen.getByTestId('storage-budget')).toHaveTextContent('82% of the budget');
    expect(screen.getByTestId('storage-budget-level')).toHaveTextContent('Getting full');
    const warning = screen.getByTestId('storage-warning');
    expect(warning).toHaveTextContent('The database is filling up');
    expect(warning).toHaveTextContent('Signals, events and outcomes are never deleted.');
    expect(screen.getByTestId('storage-table-ticks')).toHaveTextContent('8.28 GB');
    expect(screen.getByTestId('storage-backup')).toHaveTextContent(/\(1 d 1[67] h ago\)/);
    expect(screen.getByTestId('storage-maintenance')).toHaveTextContent('0 rows deleted');
  });

  it('says that the storage could not be loaded, and loads it on a retry', async () => {
    let calls = 0;
    const { user } = await open('/system?tab=storage', {
      override: (mock) => ({
        getSystemStorage: () => {
          calls += 1;
          return calls === 1 ? rejected() : mock.getSystemStorage();
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the storage');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('storage-db-size')).toBeInTheDocument();
  });

  describe('the gauge as a view', () => {
    const show = (pct: number) =>
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <BudgetGauge pct={pct} />
        </AppProviders>,
      );

    it('is fine at 79%, getting full from 80%, over the limit from 100%', () => {
      const view = show(79);
      expect(screen.getByTestId('storage-budget-level')).toHaveTextContent('Within the budget');
      expect(screen.queryByTestId('storage-warning')).not.toBeInTheDocument();
      view.unmount();
      const filling = show(80);
      expect(screen.getByTestId('storage-budget-level')).toHaveTextContent('Getting full');
      expect(screen.getByTestId('storage-warning')).toBeInTheDocument();
      filling.unmount();
      show(100);
      expect(screen.getByTestId('storage-budget-level')).toHaveTextContent('Over the soft limit');
      expect(screen.getByTestId('storage-warning')).toBeInTheDocument();
    });

    it('writes the real number above 100%, and keeps the bar inside its box', () => {
      show(137);
      expect(screen.getByTestId('storage-budget')).toHaveTextContent('137% of the budget');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });

    it('is amber while it is filling and red when it is over the limit', () => {
      const filling = show(80);
      expect(screen.getByTestId('storage-warning').getAttribute('style') ?? '').toContain(
        'warning',
      );
      filling.unmount();
      show(100);
      expect(screen.getByTestId('storage-warning').getAttribute('style') ?? '').toContain(
        'negative',
      );
    });
  });

  describe('the storage as a view', () => {
    const NOW = Date.parse('2026-10-23T12:00:00Z');
    const base: SystemStorage = {
      dbSizeBytes: 1_000_000,
      tables: [{ name: 'ticks', sizeBytes: 800_000 }],
      retention: [{ item: 'Raw ticks', rule: '14 days' }],
      budgetPct: 1,
      lastMaintenanceRun: null,
    };
    const show = (storage: SystemStorage, backupAt: string | null) =>
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <StorageView storage={storage} backupAt={backupAt} nowMs={NOW} />
        </AppProviders>,
      );

    it('says that no run and no backup were recorded, when none was', () => {
      show(base, null);
      expect(screen.getByTestId('storage-maintenance')).toHaveTextContent(
        'No maintenance run has been recorded yet.',
      );
      expect(screen.getByTestId('storage-backup')).toHaveTextContent(
        'No backup has been recorded yet.',
      );
    });

    it('says that a run is not finished, when it is not', () => {
      show(
        { ...base, lastMaintenanceRun: { job: 'retention', finishedAt: null, rowsDeleted: 12 } },
        new Date(NOW - 7_200_000).toISOString(),
      );
      expect(screen.getByTestId('storage-maintenance')).toHaveTextContent(
        'Last maintenance run: retention, not finished, 12 rows deleted.',
      );
      expect(screen.getByTestId('storage-backup')).toHaveTextContent(/\(2 h ago\)\./);
    });

    it('draws each table as its share of the biggest one', () => {
      show(
        {
          ...base,
          tables: [
            { name: 'ticks', sizeBytes: 800_000 },
            { name: 'candles_1m', sizeBytes: 200_000 },
          ],
        },
        null,
      );
      const widthOf = (name: string) =>
        screen.getByTestId(`storage-table-${name}`).querySelector<HTMLElement>('.bar-fill')?.style
          .width;
      expect([widthOf('ticks'), widthOf('candles_1m')]).toEqual(['100%', '25%']);
    });
  });
});

describe('the strategies tab', () => {
  const rowOf = (key: string) => screen.getByTestId(`strategy-row-${key}`);
  const switchOf = (kind: 'Enabled' | 'Alerts', key: (typeof STRATEGY_KEYS)[number]) =>
    within(rowOf(key)).getByRole('switch', { name: `${kind}: ${STRATEGY_LABELS[key]}` });

  it('lists the five strategies in order, with a status that is earned and the two switches', async () => {
    await open('/system?tab=strategies');
    await screen.findByTestId('strategy-row-trend_pullback');
    expect(
      screen.getAllByTestId(/^strategy-row-/).map((card) => card.getAttribute('data-testid')),
    ).toEqual(STRATEGY_KEYS.map((key) => `strategy-row-${key}`));
    for (const key of ['trend_pullback', 'sweep_reversal', 'squeeze_retest'] as const) {
      expect(screen.getByTestId(`strategy-status-${key}`), key).toHaveTextContent(
        'Forward testing',
      );
    }
    for (const key of ['trendline_retest', 'pattern_breakout'] as const) {
      expect(screen.getByTestId(`strategy-status-${key}`), key).toHaveTextContent('Research');
    }
    for (const key of STRATEGY_KEYS) {
      expect(switchOf('Enabled', key), key).toBeChecked();
      if (ALERTS_ON.includes(key)) expect(switchOf('Alerts', key), key).toBeChecked();
      else expect(switchOf('Alerts', key), key).not.toBeChecked();
    }
    expect(rowOf('trend_pullback')).toHaveTextContent('Trend Pullback');
    expect(rowOf('trend_pullback')).toHaveTextContent('trend_pullback · version 0.1.0');
    expect(rowOf('pattern_breakout')).toHaveTextContent('version 0.0.1');
  });

  it('shows the newest signal and the evidence of a strategy, and says so when there is none', async () => {
    await open('/system?tab=strategies');
    await screen.findByTestId('strategy-row-trend_pullback');
    expect(screen.getByTestId('strategy-last-trend_pullback')).not.toHaveTextContent('none yet');
    expect(screen.getByTestId('strategy-evidence-trend_pullback')).toHaveTextContent(
      /^Evidence: .*n=\d+/,
    );
    expect(screen.getByTestId('strategy-last-pattern_breakout')).toHaveTextContent(
      'Last signal: none yet',
    );
    expect(screen.getByTestId('strategy-evidence-pattern_breakout')).toHaveTextContent(
      'Evidence: No evidence yet',
    );
  });

  it('saves the alert switch at once, in both lists, and keeps the other strategies as they were', async () => {
    const { user, mock } = await open('/system?tab=strategies');
    await screen.findByTestId('strategy-row-trend_pullback');
    await user.click(switchOf('Alerts', 'trend_pullback'));
    expect(switchOf('Alerts', 'trend_pullback')).not.toBeChecked();
    await waitFor(async () => {
      expect((await mock.getSettings()).strategyAlerts.trend_pullback).toBe('off');
    });
    const saved = await mock.getStrategies();
    expect(saved.find((strategy) => strategy.key === 'trend_pullback')?.alerts).toBe(false);
    expect(saved.find((strategy) => strategy.key === 'sweep_reversal')?.alerts).toBe(true);
    expect(saved.every((strategy) => strategy.enabled)).toBe(true);

    // the Alerts tab shows the same switch
    await user.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(await screen.findByRole('switch', { name: 'Trend Pullback' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Liquidity Sweep Reversal' })).toBeChecked();
  });

  it('asks before it switches a strategy off, and changes nothing when the owner cancels', async () => {
    const updateStrategy = vi.fn<ApiClient['updateStrategy']>();
    const { user } = await open('/system?tab=strategies', {
      override: (mock) => {
        updateStrategy.mockImplementation((key, patch) => mock.updateStrategy(key, patch));
        return { updateStrategy };
      },
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    await user.click(switchOf('Enabled', 'trend_pullback'));
    const dialog = await screen.findByRole('dialog', { name: 'Switch off Trend Pullback?' });
    expect(dialog).toHaveTextContent('Signals that are already open keep being tracked');
    expect(dialog).toHaveTextContent('You can switch it on again at any time.');
    expect(switchOf('Enabled', 'trend_pullback')).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(updateStrategy).not.toHaveBeenCalled();
    expect(switchOf('Enabled', 'trend_pullback')).toBeChecked();
  });

  it('switches a strategy off after the confirmation, only that one, and on again without a question', async () => {
    const updateStrategy = vi.fn<ApiClient['updateStrategy']>();
    const { user, mock } = await open('/system?tab=strategies', {
      override: (inner) => {
        updateStrategy.mockImplementation((key, patch) => inner.updateStrategy(key, patch));
        return { updateStrategy };
      },
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    await user.click(switchOf('Enabled', 'sweep_reversal'));
    await user.click(await screen.findByTestId('strategy-disable-confirm'));
    await waitFor(() => {
      expect(switchOf('Enabled', 'sweep_reversal')).not.toBeChecked();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(updateStrategy).toHaveBeenCalledExactlyOnceWith('sweep_reversal', { enabled: false });
    await waitFor(async () => {
      const saved = await mock.getStrategies();
      expect(saved.filter((strategy) => !strategy.enabled).map((strategy) => strategy.key)).toEqual(
        ['sweep_reversal'],
      );
    });
    // the owner's other switches are untouched
    expect(switchOf('Enabled', 'trend_pullback')).toBeChecked();
    expect(switchOf('Alerts', 'sweep_reversal')).toBeChecked();

    await user.click(switchOf('Enabled', 'sweep_reversal'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(updateStrategy).toHaveBeenLastCalledWith('sweep_reversal', { enabled: true });
    });
    await waitFor(() => {
      expect(switchOf('Enabled', 'sweep_reversal')).toBeChecked();
    });
  });

  it('loads the list again after a change, so that the screen shows what the API holds', async () => {
    const getStrategies = vi.fn<ApiClient['getStrategies']>();
    const { user } = await open('/system?tab=strategies', {
      override: (mock) => {
        getStrategies.mockImplementation(() => mock.getStrategies());
        return { getStrategies };
      },
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    const before = getStrategies.mock.calls.length;
    await user.click(switchOf('Alerts', 'trend_pullback'));
    await waitFor(() => {
      expect(getStrategies.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('shows a switch at once, before the API has answered', async () => {
    const answers: (() => void)[] = [];
    let hold = false;
    const { user } = await open('/system?tab=strategies', {
      override: (mock) => ({
        updateStrategy: (key, patch) =>
          hold
            ? new Promise((resolve) => {
                answers.push(() => {
                  void mock.updateStrategy(key, patch).then(resolve);
                });
              })
            : mock.updateStrategy(key, patch),
      }),
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    hold = true;
    await user.click(switchOf('Alerts', 'sweep_reversal'));
    await waitFor(() => {
      expect(switchOf('Alerts', 'sweep_reversal')).not.toBeChecked();
    });
    expect(answers).toHaveLength(1);
    answers[0]?.();

    // switched off with the question, and on again at once, before the answer
    hold = false;
    await user.click(switchOf('Enabled', 'sweep_reversal'));
    await user.click(await screen.findByTestId('strategy-disable-confirm'));
    await waitFor(() => {
      expect(switchOf('Enabled', 'sweep_reversal')).not.toBeChecked();
    });
    hold = true;
    await user.click(switchOf('Enabled', 'sweep_reversal'));
    await waitFor(() => {
      expect(switchOf('Enabled', 'sweep_reversal')).toBeChecked();
    });
    expect(answers).toHaveLength(2);
  });

  it('puts the switch back and says so when the change could not be saved', async () => {
    const { user } = await open('/system?tab=strategies', {
      override: () => ({ updateStrategy: rejected }),
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    await user.click(switchOf('Alerts', 'trend_pullback'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The change could not be saved. Nothing was changed.',
    );
    await waitFor(() => {
      expect(switchOf('Alerts', 'trend_pullback')).toBeChecked();
    });
  });

  it('asks for the configuration only when it is opened, and shows it read only', async () => {
    const getStrategyConfig = vi.fn<ApiClient['getStrategyConfig']>();
    const { user } = await open('/system?tab=strategies', {
      override: (mock) => {
        getStrategyConfig.mockImplementation((key) => mock.getStrategyConfig(key));
        return { getStrategyConfig };
      },
    });
    await screen.findByTestId('strategy-row-trend_pullback');
    expect(getStrategyConfig).not.toHaveBeenCalled();
    const control = within(rowOf('trend_pullback')).getByRole('button', {
      name: 'Configuration (read only)',
    });
    await user.click(control);
    const config = await screen.findByTestId('strategy-config-trend_pullback');
    expect(getStrategyConfig).toHaveBeenCalledExactlyOnceWith('trend_pullback');
    expect(config).toHaveTextContent('"emaFast": 20');
    expect(config).toHaveTextContent('"maxTickAgeSec": 10');
    expect(rowOf('trend_pullback')).toHaveTextContent('Version 0.1.0.');
    expect(rowOf('trend_pullback')).toHaveTextContent('In this preview the config is made up.');
    expect(within(rowOf('trend_pullback')).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('strategy-config-sweep_reversal')).not.toBeInTheDocument();
  });

  it('says that the strategies could not be loaded, and loads them on a retry', async () => {
    let calls = 0;
    const { user } = await open('/system?tab=strategies', {
      override: (mock) => ({
        getStrategies: () => {
          calls += 1;
          return calls === 1 ? rejected() : mock.getStrategies();
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the strategies');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('strategy-row-trend_pullback')).toBeInTheDocument();
  });
});

describe('the alerts tab', () => {
  const grade = (testId: string) => screen.getByTestId(testId);

  const watchSave = () => {
    const updateSettings = vi.fn<ApiClient['updateSettings']>();
    const override: Override = (mock) => {
      updateSettings.mockImplementation((patch) => mock.updateSettings(patch));
      return { updateSettings };
    };
    return { updateSettings, override };
  };

  it('shows what is saved: Telegram, Web Push, language, flags, strategies, headlines and moves', async () => {
    await open('/system?tab=alerts');
    expect(await screen.findByRole('switch', { name: 'Telegram alerts' })).toBeChecked();
    expect(grade('alerts-telegram-grade')).toHaveValue('Moderate');
    for (const label of [
      'New signal',
      'TP1 reached',
      'Signal closed',
      'Signal cancelled',
      'System degraded',
    ]) {
      expect(screen.getByRole('checkbox', { name: label }), label).toBeChecked();
    }
    for (const label of ['Daily summary', 'Monthly report', 'Engine paused']) {
      expect(screen.getByRole('checkbox', { name: label }), label).not.toBeChecked();
    }
    expect(screen.getByRole('switch', { name: 'Web Push alerts' })).not.toBeChecked();
    expect(grade('alerts-webpush-grade')).toHaveValue('Strong');
    // two controls with the same name could not be told apart by a screen reader or by voice
    expect(
      screen.getByRole('combobox', { name: 'Telegram: minimum grade of a signal' }),
    ).toHaveValue('Moderate');
    expect(
      screen.getByRole('combobox', { name: 'Web Push: minimum grade of a signal' }),
    ).toHaveValue('Strong');
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Hinglish' })).not.toBeChecked();
    for (const key of ['newsWindow', 'rollover', 'offHours', 'nearLevel']) {
      expect(
        within(screen.getByTestId(`advisory-${key}`)).getByRole('radio', { name: 'Warn' }),
        key,
      ).toBeChecked();
    }
    for (const key of STRATEGY_KEYS) {
      const expected = expect(screen.getByRole('switch', { name: STRATEGY_LABELS[key] }), key);
      if (ALERTS_ON.includes(key)) expected.toBeChecked();
      else expected.not.toBeChecked();
    }
    expect(grade('alerts-news-min-impact')).toHaveValue('High');
    expect(screen.getByRole('switch', { name: 'Risk-off moves' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Alert for sudden moves of gold' })).toBeChecked();
    expect(screen.getByTestId('alerts-status')).toHaveTextContent(
      'Changes are saved as you make them.',
    );
  });

  it('saves the Telegram switch, the grade and the kinds as they are changed, and says Saved', async () => {
    const { updateSettings, override } = watchSave();
    const { user, mock } = await open('/system?tab=alerts', { override });
    const telegram = await screen.findByRole('switch', { name: 'Telegram alerts' });

    await user.click(telegram);
    expect(telegram).not.toBeChecked();
    await waitFor(() => {
      expect(screen.getByTestId('alerts-status')).toHaveTextContent('Saved');
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ alerts: { telegram: { enabled: false } } });

    await choose(user, 'alerts-telegram-grade', 'Very strong');
    expect(updateSettings).toHaveBeenLastCalledWith({
      alerts: { telegram: { minGrade: 'Very strong' } },
    });
    expect(grade('alerts-telegram-grade')).toHaveValue('Very strong');

    await user.click(screen.getByRole('checkbox', { name: 'Daily summary' }));
    await user.click(screen.getByRole('checkbox', { name: 'New signal' }));
    // the kinds keep the order of the list, whatever the order of the clicks
    expect(updateSettings).toHaveBeenLastCalledWith({
      alerts: {
        telegram: {
          kinds: [
            'SIGNAL_TP1',
            'SIGNAL_CLOSED',
            'SIGNAL_CANCELLED',
            'SYSTEM_DEGRADED',
            'DAILY_DIGEST',
          ],
        },
      },
    });
    await waitFor(async () => {
      const saved = (await mock.getSettings()).alerts.telegram;
      expect(saved.enabled).toBe(false);
      expect(saved.minGrade).toBe('Very strong');
      expect(saved.kinds).toEqual([
        'SIGNAL_TP1',
        'SIGNAL_CLOSED',
        'SIGNAL_CANCELLED',
        'SYSTEM_DEGRADED',
        'DAILY_DIGEST',
      ]);
    });
  });

  it('keeps the kinds in the order of the list when a kind from the middle is added', async () => {
    const { updateSettings, override } = watchSave();
    const { user } = await open('/system?tab=alerts', { override });
    await user.click(await screen.findByRole('checkbox', { name: 'Final review of a loss' }));
    expect(updateSettings).toHaveBeenLastCalledWith({
      alerts: {
        telegram: {
          kinds: [
            'SIGNAL_NEW',
            'SIGNAL_TP1',
            'SIGNAL_CLOSED',
            'SIGNAL_CANCELLED',
            'SIGNAL_REVIEW_FINAL',
            'SYSTEM_DEGRADED',
          ],
        },
      },
    });
  });

  it('saves the Web Push switch and its grade, and not the Telegram ones', async () => {
    const { updateSettings, override } = watchSave();
    const { user, mock } = await open('/system?tab=alerts', { override });
    await user.click(await screen.findByRole('switch', { name: 'Web Push alerts' }));
    expect(updateSettings).toHaveBeenLastCalledWith({ alerts: { webpush: { enabled: true } } });
    await choose(user, 'alerts-webpush-grade', 'Very strong');
    expect(updateSettings).toHaveBeenLastCalledWith({
      alerts: { webpush: { minGrade: 'Very strong' } },
    });
    await waitFor(async () => {
      const saved = (await mock.getSettings()).alerts;
      expect(saved.webpush).toEqual({ enabled: true, minGrade: 'Very strong' });
      expect(saved.telegram.minGrade).toBe('Moderate');
    });
  });

  it('shows a change at once, before the API has answered, and keeps it when the answer comes', async () => {
    const answers: (() => void)[] = [];
    const { user } = await open('/system?tab=alerts', {
      override: (mock) => ({
        updateSettings: (patch) =>
          new Promise((resolve) => {
            answers.push(() => {
              void mock.updateSettings(patch).then(resolve);
            });
          }),
      }),
    });
    const telegram = await screen.findByRole('switch', { name: 'Telegram alerts' });
    await user.click(telegram);
    await waitFor(() => {
      expect(telegram).not.toBeChecked();
    });
    expect(answers).toHaveLength(1);
    expect(screen.getByTestId('alerts-status')).toHaveTextContent('Saving…');
    answers[0]?.();
    await waitFor(() => {
      expect(screen.getByTestId('alerts-status')).toHaveTextContent('Saved');
    });
    expect(telegram).not.toBeChecked();
  });

  it('saves the language, a flag set to block, and one flag without touching the others', async () => {
    const { updateSettings, override } = watchSave();
    const { user, mock } = await open('/system?tab=alerts', { override });
    await user.click(await screen.findByRole('radio', { name: 'Hinglish' }));
    expect(updateSettings).toHaveBeenLastCalledWith({ locale: 'hinglish' });
    await user.click(
      within(screen.getByTestId('advisory-rollover')).getByRole('radio', { name: 'Block' }),
    );
    expect(updateSettings).toHaveBeenLastCalledWith({ advisoryGates: { rollover: 'block' } });
    await waitFor(async () => {
      const saved = await mock.getSettings();
      expect(saved.locale).toBe('hinglish');
      expect(saved.advisoryGates).toEqual({
        newsWindow: 'warn',
        rollover: 'block',
        offHours: 'warn',
        nearLevel: 'warn',
      });
    });
    expect(
      within(screen.getByTestId('advisory-rollover')).getByRole('radio', { name: 'Block' }),
    ).toBeChecked();
  });

  it('saves the strategy alerts, the headline impact, the topics and the move alerts', async () => {
    const { updateSettings, override } = watchSave();
    const { user, mock } = await open('/system?tab=alerts', { override });
    await user.click(await screen.findByRole('switch', { name: 'Squeeze Breakout and Retest' }));
    expect(updateSettings).toHaveBeenLastCalledWith({
      strategyAlerts: { squeeze_retest: 'off' },
    });
    await user.click(screen.getByRole('switch', { name: 'Trendline Break and Retest' }));
    expect(updateSettings).toHaveBeenLastCalledWith({
      strategyAlerts: { trendline_retest: 'on' },
    });
    await choose(user, 'alerts-news-min-impact', 'Medium');
    expect(updateSettings).toHaveBeenLastCalledWith({ newsAlerts: { minImpact: 'MEDIUM' } });
    await user.click(screen.getByRole('switch', { name: 'Trump policy' }));
    expect(updateSettings).toHaveBeenLastCalledWith({
      newsAlerts: { topics: { TRUMP_POLICY: 'off' } },
    });
    await user.click(screen.getByRole('switch', { name: 'Alert for sudden moves of gold' }));
    expect(updateSettings).toHaveBeenLastCalledWith({ newsAlerts: { marketMoves: 'off' } });
    await waitFor(async () => {
      const saved = await mock.getSettings();
      expect(saved.strategyAlerts.squeeze_retest).toBe('off');
      expect(saved.strategyAlerts.trendline_retest).toBe('on');
      expect(saved.strategyAlerts.trend_pullback).toBe('on');
      expect(saved.newsAlerts.minImpact).toBe('MEDIUM');
      expect(saved.newsAlerts.topics.TRUMP_POLICY).toBe('off');
      expect(saved.newsAlerts.topics.FED_RATES).toBe('on');
      expect(saved.newsAlerts.marketMoves).toBe('off');
    });

    // the Strategies tab shows the same alert switches
    await user.click(screen.getByRole('tab', { name: 'Strategies' }));
    const card = await screen.findByTestId('strategy-row-squeeze_retest');
    await waitFor(() => {
      expect(
        within(card).getByRole('switch', { name: 'Alerts: Squeeze Breakout and Retest' }),
      ).not.toBeChecked();
    });
    expect(
      within(screen.getByTestId('strategy-row-trendline_retest')).getByRole('switch', {
        name: 'Alerts: Trendline Break and Retest',
      }),
    ).toBeChecked();
  });

  it('puts the switch back and says that nothing was changed when the save fails', async () => {
    const { user } = await open('/system?tab=alerts', {
      override: () => ({ updateSettings: rejected }),
    });
    const telegram = await screen.findByRole('switch', { name: 'Telegram alerts' });
    await user.click(telegram);
    const status = await screen.findByRole('alert');
    expect(status).toHaveTextContent('The change could not be saved');
    expect(status).toHaveTextContent('Nothing was changed.');
    await waitFor(() => {
      expect(telegram).toBeChecked();
    });
  });

  it('queues a test message and says so, and the health tab sees the send', async () => {
    const { user, mock } = await open('/system?tab=alerts');
    await user.click(await screen.findByTestId('alerts-test-button'));
    const result = await screen.findByTestId('alerts-test-result');
    expect(result).toHaveTextContent(/^Test message queued \(test:[0-9a-f-]{36}\)\./);
    expect(result).toHaveTextContent('It is sent by the worker within a few seconds.');
    const sentAt = (await mock.getSystemHealth()).telegram.lastSendAt;
    expect(sentAt).not.toBeNull();
    expect(Date.now() - Date.parse(sentAt ?? '')).toBeLessThan(60_000);
  });

  it('says why a test message could not be queued', async () => {
    const { user } = await open('/system?tab=alerts', {
      override: () => ({
        sendTestNotification: () =>
          Promise.reject(new ApiError(503, 'telegram_unavailable', 'Telegram is not set up yet.')),
      }),
    });
    await user.click(await screen.findByTestId('alerts-test-button'));
    const result = await screen.findByTestId('alerts-test-result');
    expect(result).toHaveAttribute('role', 'alert');
    expect(result).toHaveTextContent('Telegram is not set up yet.');
  });

  it('says that a test message could not be queued, for any other failure', async () => {
    const { user } = await open('/system?tab=alerts', {
      override: () => ({ sendTestNotification: () => Promise.reject(new Error('down')) }),
    });
    await user.click(await screen.findByTestId('alerts-test-button'));
    expect(await screen.findByTestId('alerts-test-result')).toHaveTextContent(
      'The test message could not be queued.',
    );
  });

  it('keeps the Web Push buttons off until the app can subscribe a device, and says why', async () => {
    await open('/system?tab=alerts');
    expect(await screen.findByTestId('alerts-webpush-subscribe')).toBeDisabled();
    expect(screen.getByTestId('alerts-webpush-test')).toBeDisabled();
    expect(screen.getByTestId('alerts-webpush-note')).toHaveTextContent('built in phase U6');
  });

  it('says that the settings could not be loaded, and loads them on a retry', async () => {
    let calls = 0;
    const { user } = await open('/system?tab=alerts', {
      override: (mock) => ({
        getSettings: () => {
          calls += 1;
          return calls === 1 ? rejected() : mock.getSettings();
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the settings');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch', { name: 'Telegram alerts' })).toBeInTheDocument();
  });
});

describe('the display tab', () => {
  it('shows the time zone and the time in it, and the numbers as they are', async () => {
    await open('/system?tab=display');
    expect(await screen.findByTestId('display-timezone')).toHaveValue('Asia/Kolkata');
    expect(screen.getByTestId('display-now')).toHaveTextContent(/^Now: .+ \(IST\)$/);
    expect(screen.getByTestId('display-numbers')).toHaveTextContent('3 decimals');
    expect(screen.getByTestId('display-numbers')).toHaveTextContent('2 decimals');
    expect(screen.getByTestId('display-numbers')).toHaveTextContent('These do not change.');
    // the numbers have no setting: the only control of the tab is the time zone
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('lists the common zones first, and finds any other zone by typing', async () => {
    const { user, mock } = await open('/system?tab=display');
    const input = await screen.findByTestId('display-timezone');
    await user.click(input);
    const listId = input.getAttribute('aria-controls') ?? '';
    const menu = document.getElementById(listId);
    if (menu === null) throw new Error('the menu did not open');
    // a short menu: it does not scroll, so nothing is out of reach of the keyboard
    expect(within(menu).getAllByRole('option', { hidden: true })).toHaveLength(11);
    expect(
      within(menu).getByRole('option', { name: 'Europe/London', hidden: true }),
    ).toBeInTheDocument();
    expect(within(menu).queryByRole('option', { name: 'Asia/Karachi', hidden: true })).toBeNull();

    await user.clear(input);
    await user.type(input, 'Karachi');
    await user.click(await screen.findByRole('option', { name: 'Asia/Karachi', hidden: true }));
    await waitFor(async () => {
      expect((await mock.getSettings()).displayTz).toBe('Asia/Karachi');
    });
    expect(screen.getByTestId('display-timezone')).toHaveValue('Asia/Karachi');
  });

  it('saves a new time zone, and the time on the page follows it', async () => {
    const { user, mock } = await open('/system?tab=display');
    await screen.findByTestId('display-timezone');
    await choose(user, 'display-timezone', 'America/New York');
    await waitFor(async () => {
      expect((await mock.getSettings()).displayTz).toBe('America/New_York');
    });
    expect(screen.getByTestId('display-timezone')).toHaveValue('America/New York');
    expect(screen.getByTestId('display-now')).toHaveTextContent(/\((EDT|EST)\)$/);
    expect(screen.getByTestId('display-now')).not.toHaveTextContent('IST');
  });

  it('puts the zone back and says so when it could not be saved', async () => {
    const { user } = await open('/system?tab=display', {
      override: () => ({ updateSettings: rejected }),
    });
    await screen.findByTestId('display-timezone');
    await choose(user, 'display-timezone', 'UTC');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The time zone could not be saved. Nothing was changed.',
    );
    await waitFor(() => {
      expect(screen.getByTestId('display-timezone')).toHaveValue('Asia/Kolkata');
    });
  });
});

describe('the security tab', () => {
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    values: { current?: string; next?: string; confirm?: string },
  ) => {
    if (values.current !== undefined) {
      await user.type(screen.getByLabelText('Current password'), values.current);
    }
    if (values.next !== undefined)
      await user.type(screen.getByLabelText('New password'), values.next);
    if (values.confirm !== undefined) {
      await user.type(screen.getByLabelText('Repeat the new password'), values.confirm);
    }
  };
  const NEW_PASSWORD = 'a much longer password';

  describe('the password', () => {
    it('says what is missing and sends nothing', async () => {
      const changePassword = vi.fn<ApiClient['changePassword']>();
      const { user } = await open('/system?tab=security', {
        override: () => ({ changePassword }),
      });
      await user.click(await screen.findByTestId('password-submit'));
      expect(await screen.findByText('Enter your current password')).toBeInTheDocument();
      expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument();
      expect(changePassword).not.toHaveBeenCalled();
    });

    it('wants 12 characters, a different password, and the same one twice', async () => {
      const changePassword = vi.fn<ApiClient['changePassword']>();
      const { user } = await open('/system?tab=security', {
        override: () => ({ changePassword }),
      });
      await screen.findByTestId('password-submit');
      await fill(user, { current: MOCK_PASSWORD, next: '11 chars pwd', confirm: 'something else' });
      await user.click(screen.getByTestId('password-submit'));
      expect(await screen.findByText('The two passwords are not the same')).toBeInTheDocument();
      expect(screen.queryByText('Use at least 12 characters')).not.toBeInTheDocument();
      expect(changePassword).not.toHaveBeenCalled();
    });

    it('refuses a new password that is the current one', async () => {
      const { user } = await open('/system?tab=security');
      await screen.findByTestId('password-submit');
      await fill(user, {
        current: 'the very same password',
        next: 'the very same password',
        confirm: 'the very same password',
      });
      await user.click(screen.getByTestId('password-submit'));
      expect(
        await screen.findByText('The new password must be different from the current one'),
      ).toBeInTheDocument();
    });

    it('says that the current password is not right, and keeps what was typed', async () => {
      const { user } = await open('/system?tab=security');
      await screen.findByTestId('password-submit');
      await fill(user, { current: 'not the password', next: NEW_PASSWORD, confirm: NEW_PASSWORD });
      await user.click(screen.getByTestId('password-submit'));
      expect(await screen.findByTestId('password-result')).toHaveTextContent(
        'The current password is not right.',
      );
      expect(screen.getByLabelText('New password')).toHaveValue(NEW_PASSWORD);
    });

    it('changes the password, clears the form, and signs the other sessions out', async () => {
      const changePassword = vi.fn<ApiClient['changePassword']>();
      const { user, mock } = await open('/system?tab=security', {
        override: (inner) => {
          changePassword.mockImplementation((request) => inner.changePassword(request));
          return { changePassword };
        },
      });
      expect(await screen.findByTestId('sessions-table')).toBeInTheDocument();
      expect(within(screen.getByTestId('sessions-table')).getAllByRole('row')).toHaveLength(4);
      await fill(user, { current: MOCK_PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD });
      await user.click(screen.getByTestId('password-submit'));
      expect(await screen.findByTestId('password-result')).toHaveTextContent(
        'Password changed. Every other session was signed out.',
      );
      expect(changePassword).toHaveBeenCalledExactlyOnceWith({
        current: MOCK_PASSWORD,
        next: NEW_PASSWORD,
      });
      expect(screen.getByLabelText('Current password')).toHaveValue('');
      expect(screen.getByLabelText('New password')).toHaveValue('');
      await waitFor(() => {
        expect(within(screen.getByTestId('sessions-table')).getAllByRole('row')).toHaveLength(2);
      });
      expect(screen.getByTestId('session-sess-current')).toBeInTheDocument();
      expect(mock.preview?.password).toBe(NEW_PASSWORD);
    });

    it('says in the preview that the password lives only in the browser', async () => {
      await open('/system?tab=security');
      expect(await screen.findByTestId('password-preview-note')).toHaveTextContent(
        'Do not type a password that you use anywhere else.',
      );
    });
  });

  describe('the second step of the login', () => {
    it('is off at first, and sets up with a key, a link and the code of the preview', async () => {
      const { user } = await open('/system?tab=security');
      expect(await screen.findByTestId('totp-state')).toHaveTextContent('2-step login is off.');
      await user.click(await screen.findByTestId('totp-setup'));
      const panel = await screen.findByTestId('totp-setup-panel');
      expect(within(panel).getByTestId('totp-secret').textContent).toMatch(/^[A-Z2-7]{16,}$/);
      expect(panel).toHaveTextContent('otpauth://totp/VM%20Gold%20Signal:owner?secret=');
      expect(panel).toHaveTextContent(`In this preview the code is ${MOCK_TOTP_CODE}.`);
      expect(screen.queryByTestId('totp-setup')).not.toBeInTheDocument();
      await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByTestId('totp-setup')).toBeInTheDocument();
      expect(screen.getByTestId('totp-state')).toHaveTextContent('2-step login is off.');
    });

    it('wants six digits, and says when the code is not right', async () => {
      const enableTotp = vi.fn<ApiClient['enableTotp']>();
      const { user } = await open('/system?tab=security', {
        override: (mock) => {
          enableTotp.mockImplementation((request) => mock.enableTotp(request));
          return { enableTotp };
        },
      });
      await user.click(await screen.findByTestId('totp-setup'));
      await user.type(await screen.findByTestId('totp-code'), '12ab');
      await user.click(screen.getByTestId('totp-enable'));
      expect(await screen.findByText('The code has 6 digits')).toBeInTheDocument();
      expect(enableTotp).not.toHaveBeenCalled();

      await user.clear(screen.getByTestId('totp-code'));
      await user.type(screen.getByTestId('totp-code'), '654321');
      await user.click(screen.getByTestId('totp-enable'));
      expect(await screen.findByText('This code is not right.')).toBeInTheDocument();
      expect(screen.getByTestId('totp-state')).toHaveTextContent('2-step login is off.');
    });

    it('turns on with the right code, shows the eight recovery codes once, and turns off again', async () => {
      const { user } = await open('/system?tab=security');
      await user.click(await screen.findByTestId('totp-setup'));
      await user.type(await screen.findByTestId('totp-code'), MOCK_TOTP_CODE);
      await user.click(screen.getByTestId('totp-enable'));

      const codes = await screen.findByTestId('totp-recovery-codes');
      expect(within(codes).getAllByRole('listitem')).toHaveLength(8);
      for (const item of within(codes).getAllByRole('listitem')) {
        expect(item.textContent).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
      }
      expect(codes).toHaveTextContent('They are shown only now.');
      expect(screen.getByTestId('totp-state')).toHaveTextContent('2-step login is on.');
      expect(screen.queryByTestId('totp-disable')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('totp-codes-done'));
      expect(screen.queryByTestId('totp-recovery-codes')).not.toBeInTheDocument();
      expect(screen.queryByText(/^[a-z0-9]{4}-[a-z0-9]{4}$/)).not.toBeInTheDocument();

      await user.type(screen.getByTestId('totp-disable-code'), '000000');
      await user.click(screen.getByTestId('totp-disable'));
      expect(await screen.findByText('This code is not right.')).toBeInTheDocument();
      expect(screen.getByTestId('totp-state')).toHaveTextContent('2-step login is on.');

      await user.clear(screen.getByTestId('totp-disable-code'));
      await user.type(screen.getByTestId('totp-disable-code'), MOCK_TOTP_CODE);
      await user.click(screen.getByTestId('totp-disable'));
      expect(await screen.findByTestId('totp-setup')).toBeInTheDocument();
      expect(screen.getByTestId('totp-state')).toHaveTextContent('2-step login is off.');
    });

    it('asks for the code at the next login, once it is on', async () => {
      const { user, router } = await open('/system?tab=security');
      await user.click(await screen.findByTestId('totp-setup'));
      await user.type(await screen.findByTestId('totp-code'), MOCK_TOTP_CODE);
      await user.click(screen.getByTestId('totp-enable'));
      await screen.findByTestId('totp-recovery-codes');

      await user.click(screen.getByRole('button', { name: 'Log out' }));
      await user.type(await screen.findByLabelText(/^username/i), MOCK_USERNAME);
      await user.type(screen.getByLabelText(/^password/i), MOCK_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Log in' }));
      expect(await screen.findByTestId('login-error')).toBeInTheDocument();

      await user.type(screen.getByLabelText(/authenticator code/i), MOCK_TOTP_CODE);
      await user.click(screen.getByRole('button', { name: 'Log in' }));
      // the owner comes back to the page that he left
      expect(await screen.findByRole('heading', { name: 'System', level: 1 })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/system');
    });

    it('tells the preview visitor the code on the login page', async () => {
      renderApp({ route: '/login' });
      expect(await screen.findByTestId('login-preview-hint')).toHaveTextContent(
        `If you turn on 2-step login in the preview, its code is ${MOCK_TOTP_CODE}`,
      );
    });
  });

  describe('the sessions', () => {
    it('lists this session first, without a Revoke button, and the other two with one', async () => {
      await open('/system?tab=security');
      const table = await screen.findByTestId('sessions-table');
      const rows = within(table).getAllByTestId(/^session-sess-/);
      expect(rows.map((sessionRow) => sessionRow.getAttribute('data-testid'))).toEqual([
        'session-sess-current',
        'session-sess-phone',
        'session-sess-laptop',
      ]);
      const current = screen.getByTestId('session-sess-current');
      expect(current).toHaveTextContent('This device');
      expect(within(current).queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-revoke-sess-phone')).toBeInTheDocument();
      expect(screen.getByTestId('session-revoke-sess-laptop')).toBeInTheDocument();
    });

    it('asks before it revokes, and keeps the session when the owner cancels', async () => {
      const revokeSession = vi.fn<ApiClient['revokeSession']>();
      const { user } = await open('/system?tab=security', {
        override: () => ({ revokeSession }),
      });
      await user.click(await screen.findByTestId('session-revoke-sess-phone'));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });
      expect(dialog).toHaveTextContent('signed out at once');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(revokeSession).not.toHaveBeenCalled();
      expect(screen.getByTestId('session-sess-phone')).toBeInTheDocument();
    });

    it('revokes the session that was chosen, and no other', async () => {
      const revokeSession = vi.fn<ApiClient['revokeSession']>();
      const { user } = await open('/system?tab=security', {
        override: (mock) => {
          revokeSession.mockImplementation((id) => mock.revokeSession(id));
          return { revokeSession };
        },
      });
      await user.click(await screen.findByTestId('session-revoke-sess-laptop'));
      await user.click(await screen.findByTestId('session-revoke-confirm'));
      await waitFor(() => {
        expect(screen.queryByTestId('session-sess-laptop')).not.toBeInTheDocument();
      });
      expect(revokeSession).toHaveBeenCalledExactlyOnceWith('sess-laptop');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-sess-phone')).toBeInTheDocument();
      expect(screen.getByTestId('session-sess-current')).toBeInTheDocument();
    });

    it('says that a session could not be revoked, and closes the question', async () => {
      const { user } = await open('/system?tab=security', {
        override: () => ({ revokeSession: rejected }),
      });
      await user.click(await screen.findByTestId('session-revoke-sess-phone'));
      await user.click(await screen.findByTestId('session-revoke-confirm'));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The session could not be revoked.',
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-sess-phone')).toBeInTheDocument();
    });
  });
});
