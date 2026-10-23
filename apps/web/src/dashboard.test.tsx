import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SseEvent } from '@vmgs/contracts';
import { QUALITY_GROUPS } from '@vmgs/core';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api/client';
import { GROUP_LABELS } from './format/signal';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
import { memoryStorage, renderApp } from './test-utils';

/** A logged-in mock client in one scenario, with a hook to push stream events into the app. */
async function start(scenario: string) {
  const mock = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 600_000,
    signalUpdateIntervalMs: 600_000,
    scenario,
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
  renderApp({ client, route: '/' });
  await screen.findByTestId('page-dashboard');
  return {
    client,
    emit: (event: SseEvent) => {
      act(() => {
        listener?.(event);
      });
    },
  };
}

const card = (seq: number) => within(screen.getByTestId(`signal-card-${String(seq)}`));

describe('open signals (scenario E5)', () => {
  it('shows one card per open signal, newest first, with the count and the total open risk', async () => {
    await start('two-open');
    const panel = await screen.findByTestId('open-signals');
    await within(panel).findByTestId('signal-card-42');
    expect(within(panel).getByTestId('open-count')).toHaveTextContent('2');
    expect(within(panel).getByTestId('open-risk')).toHaveTextContent('2.00R');
    const order = within(panel)
      .getAllByTestId('signal-id')
      .map((el) => el.textContent);
    expect(order).toEqual(['S-0043', 'S-0042']);
  });

  it('every field of a card equals what the API sent (prices with 3 decimals)', async () => {
    const { client } = await start('two-open');
    const open = await client.getOpenSignals();
    const buy = open.items.find((i) => i.signal.seq === 42);
    await screen.findByTestId('signal-card-42');
    const c = card(42);
    expect(c.getByTestId('signal-side')).toHaveTextContent('BUY');
    expect(c.getByTestId('signal-id')).toHaveTextContent('S-0042');
    expect(c.getByTestId('signal-grade')).toHaveTextContent('Strong 78');
    expect(c.getByTestId('signal-entry')).toHaveTextContent('4017.370');
    expect(c.getByTestId('signal-stop')).toHaveTextContent('4010.900');
    expect(c.getByTestId('signal-tp1')).toHaveTextContent('4023.840');
    expect(c.getByTestId('signal-tp2')).toHaveTextContent('4030.310');
    expect(c.getByTestId('signal-state')).toHaveTextContent('ACTIVE');
    const r = buy?.live.unrealisedR ?? 0;
    expect(c.getByTestId('signal-live-r').textContent).toMatch(/^[+-]?\d\.\d{2}R$/);
    expect(c.getByTestId('signal-live-r').textContent).toBe(
      `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r).toFixed(2)}R`,
    );
  });

  it('the opposing signal carries the OPPOSES chip and the forward-test label; the first does not', async () => {
    await start('two-open');
    await screen.findByTestId('signal-card-43');
    expect(card(43).getByTestId('signal-warning-OPPOSES_OPEN')).toHaveTextContent(
      'Opposes open signal S-0042',
    );
    expect(card(43).getByTestId('signal-warning-UNVALIDATED_STRATEGY')).toHaveTextContent(
      'FORWARD-TEST',
    );
    expect(card(42).queryByTestId('signal-warning-OPPOSES_OPEN')).toBeNull();
  });

  it('every evidence group has a row with a state chip and its values', async () => {
    await start('two-open');
    await screen.findByTestId('signal-card-42');
    for (const key of QUALITY_GROUPS) {
      const row = card(42).getByTestId(`signal-why-group-${key}`);
      expect(row).toHaveTextContent(GROUP_LABELS[key]);
      expect(within(row).getByTestId(`signal-why-state-${key}`).textContent).toMatch(
        /^(STRONG|OK|WEAK|FAIL|NA)$/,
      );
    }
    const trend = card(42).getByTestId('signal-why-group-trend');
    expect(trend).toHaveTextContent('1h EMA: 20>50>200');
    expect(trend).toHaveTextContent('ADX(1h): 31 rising');
    expect(card(42).getByTestId('signal-weak')).toHaveTextContent('1h momentum flat');
    expect(card(42).getByTestId('signal-research')).toHaveTextContent('DXY 15m: -0.2%');
  });

  it('shows the evidence with its sample size and interval, and a low-sample label', async () => {
    await start('two-open');
    await screen.findByTestId('signal-card-42');
    const evidence = card(42).getByTestId('signal-evidence');
    expect(within(evidence).getByTestId('evidence-win-rate')).toHaveTextContent('58%');
    expect(within(evidence).getByTestId('evidence-n')).toHaveTextContent('n=64');
    expect(within(evidence).getByTestId('evidence-ci')).toHaveTextContent('46\u201369%');
    expect(evidence).toHaveTextContent('Low sample');
    expect(evidence).toHaveTextContent('not a guarantee');
  });

  it('updates the live R from the stream without reloading', async () => {
    const { client, emit } = await start('two-open');
    await screen.findByTestId('signal-card-42');
    const open = await client.getOpenSignals();
    const id = open.items.find((i) => i.signal.seq === 42)?.signal.id ?? '';
    emit({
      event: 'signal_update',
      data: { id, status: 'ACTIVE', unrealisedR: 0.77, stop: 4010.9 },
    });
    await waitFor(() => {
      expect(card(42).getByTestId('signal-live-r')).toHaveTextContent('+0.77R');
    });
    // The other card is untouched.
    expect(card(43).getByTestId('signal-live-r').textContent).not.toBe('+0.77R');
  });
});

describe('evidence below the minimum sample (scenario E6)', () => {
  it('shows the counts and "Insufficient evidence", never a percentage', async () => {
    await start('two-open');
    await screen.findByTestId('signal-card-43');
    const evidence = card(43).getByTestId('signal-evidence');
    expect(evidence).toHaveTextContent('Insufficient evidence');
    expect(evidence).toHaveTextContent('18 resolved trades');
    expect(evidence).toHaveTextContent('10 wins');
    expect(evidence.textContent).not.toMatch(/%/);
    expect(within(evidence).queryByTestId('evidence-win-rate')).toBeNull();
  });

  it('the month counter shows no win rate under 30 results either', async () => {
    await start('open-buy');
    const month = await screen.findByTestId('counters-month');
    await waitFor(() => {
      expect(within(month).getByTestId('month-win-rate')).toHaveTextContent(
        'Insufficient evidence (12 results)',
      );
    });
    expect(month.textContent).not.toMatch(/%/);
  });
});

describe('states of the signal column', () => {
  it('WAIT shows the exact reasons from the API as chips (scenario E4)', async () => {
    const { client } = await start('wait');
    const expected = (await client.getSnapshot()).engine.waitReasons;
    const chips = await within(await screen.findByTestId('wait-reasons')).findAllByRole('listitem');
    expect(chips.map((chip) => chip.textContent)).toEqual(expected.map((r) => r.label));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Spread too high: 0.90 USD',
      'News window: CPI in 22 min',
      'Regime: range, no strategy accepts it',
    ]);
    expect(screen.getByTestId('open-count')).toHaveTextContent('0');
    // The same reasons also explain the state in the bottom card.
    expect(within(screen.getByTestId('engine-reasons')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('WARMING_UP shows the progress and the missing timeframes, and no signal', async () => {
    await start('warming-up');
    const card = await screen.findByTestId('warming-up');
    expect(card).toHaveTextContent('62%');
    expect(within(card).getByTestId('warmup-missing')).toHaveTextContent('1h');
    expect(within(card).getByTestId('warmup-missing')).toHaveTextContent('4h');
    expect(within(card).getByRole('progressbar', { name: 'Warm-up progress' })).toBeInTheDocument();
    expect(screen.queryByTestId('wait-card')).toBeNull();
    expect(screen.getByTestId('status-engine')).toHaveTextContent('WARMING UP');
  });

  it('MARKET_CLOSED is grey, shows the last price and time, and no alert banner', async () => {
    await start('market-closed');
    const closed = await screen.findByTestId('market-closed');
    expect(closed).toHaveTextContent(/Last price \d{4}\.\d{3} at /);
    expect(closed).toHaveTextContent('IST');
    expect(screen.getByTestId('status-freshness')).toHaveTextContent('MARKET CLOSED');
    expect(screen.queryByTestId('feed-banner')).toBeNull();
  });

  it('TP1_HIT shows the stop at break-even', async () => {
    await start('tp1-hit');
    await screen.findByTestId('signal-card-42');
    expect(card(42).getByTestId('signal-state')).toHaveTextContent('TP1 HIT');
    expect(card(42).getByTestId('signal-stop')).toHaveTextContent('4017.370');
    expect(screen.getByTestId('signal-card-42')).toHaveTextContent('Stop (break-even)');
  });
});

describe('stale feed (scenario E3)', () => {
  it('shows the red banner, DATA_STALE in the card and a blocked engine, and recovery clears them', async () => {
    const user = userEvent.setup();
    await start('stale');
    const banner = await screen.findByTestId('feed-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('DATA STALE');
    await screen.findByTestId('signal-card-42');
    await waitFor(() => {
      expect(card(42).getByTestId('signal-state')).toHaveTextContent('DATA_STALE');
    });
    expect(screen.getByTestId('signal-card-42')).toHaveTextContent('cannot be tracked');
    expect(screen.getByTestId('status-freshness')).toHaveTextContent('STALE');
    expect(screen.getByTestId('status-engine')).toHaveTextContent('BLOCKED: NO DATA');

    await user.selectOptions(screen.getByTestId('preview-scenario'), 'open-buy');
    await waitFor(() => {
      expect(screen.queryByTestId('feed-banner')).toBeNull();
    });
    await waitFor(() => {
      expect(card(42).getByTestId('signal-state')).toHaveTextContent('ACTIVE');
    });
    expect(screen.getByTestId('status-engine')).toHaveTextContent('RUNNING');
  });

  it('a disconnected feed has its own banner text', async () => {
    await start('disconnected');
    expect(await screen.findByTestId('feed-banner')).toHaveTextContent('FEED DISCONNECTED');
    await screen.findByTestId('signal-card-42');
    await waitFor(() => {
      expect(card(42).getByTestId('signal-state')).toHaveTextContent('DISCONNECTED');
    });
  });
});

describe('pause and resume', () => {
  it('asks before pausing, then shows the amber card and resumes with one click', async () => {
    const user = userEvent.setup();
    await start('open-buy');
    await screen.findByTestId('signal-card-42');
    await user.click(screen.getByTestId('pause-button'));
    const dialog = await screen.findByRole('dialog', { name: 'Pause the engine?' });
    expect(dialog).toHaveTextContent('never pauses itself');
    // Nothing has changed before the owner confirms.
    expect(screen.getByTestId('status-engine')).toHaveTextContent('RUNNING');
    await user.click(within(dialog).getByTestId('pause-confirm'));

    expect(await screen.findByTestId('paused-card')).toHaveTextContent('Engine paused');
    await waitFor(() => {
      expect(screen.getByTestId('status-engine')).toHaveTextContent('PAUSED');
    });
    // Open signals are still tracked while paused.
    expect(screen.getByTestId('signal-card-42')).toBeInTheDocument();

    await user.click(screen.getByTestId('resume-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('paused-card')).toBeNull();
    });
    expect(screen.getByTestId('status-engine')).toHaveTextContent('RUNNING');
  });

  it('cancelling the dialog pauses nothing', async () => {
    const user = userEvent.setup();
    const { client } = await start('open-buy');
    const pause = vi.spyOn(client, 'pauseEngine');
    await screen.findByTestId('signal-card-42');
    await user.click(screen.getByTestId('pause-button'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(pause).not.toHaveBeenCalled();
  });
});

describe('the rest of the dashboard', () => {
  it('lists the last five signals with results and links to their detail', async () => {
    await start('two-open');
    const recent = await screen.findByTestId('recent-signals');
    await within(recent).findByTestId('recent-row-43');
    const rows = within(recent).getAllByTestId(/^recent-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'recent-row-43',
      'recent-row-42',
      'recent-row-41',
      'recent-row-40',
      'recent-row-39',
    ]);
    const [open43, , win41, loss40] = rows.map((row) => within(row));
    expect(open43?.getByText('Open')).toBeInTheDocument();
    expect(win41?.getByText('Win')).toBeInTheDocument();
    expect(win41?.getByText('+1.47R')).toBeInTheDocument();
    expect(loss40?.getByText('Loss')).toBeInTheDocument();
    const link = open43?.getByRole('link', { name: 'S-0043' });
    expect(link?.getAttribute('href')).toMatch(/^\/signals\/[0-9a-f-]{36}$/);
  });

  it('shows today and this month', async () => {
    await start('two-open');
    const today = await screen.findByTestId('counters-today');
    await waitFor(() => {
      expect(within(today).getByTestId('today-net-r')).toHaveTextContent('+1.47R');
    });
    expect(today).toHaveTextContent('Generated');
    const month = screen.getByTestId('counters-month');
    await waitFor(() => {
      expect(month).toHaveTextContent('Properly tracked');
    });
  });

  it('shows the news state, the next event with a countdown and headlines that say they are simulated', async () => {
    await start('wait');
    const events = await screen.findByTestId('events-card');
    await waitFor(() => {
      expect(within(events).getByTestId('news-state')).toHaveTextContent('IN WINDOW');
    });
    expect(within(events).getByTestId('news-next')).toHaveTextContent(/in 2[12] min/);
    const headlines = await within(events).findByTestId('news-headlines');
    await waitFor(() => {
      expect(within(headlines).getAllByRole('link')).toHaveLength(3);
    });
    for (const link of within(headlines).getAllByRole('link')) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.textContent).toMatch(/^Simulated headline/);
    }
  });

  it('shows times in the display time zone with UTC in the tooltip', async () => {
    await start('two-open');
    await screen.findByTestId('signal-card-42');
    const recent = within(await screen.findByTestId('recent-signals'));
    const time = (await recent.findAllByText(/IST$/))[0];
    expect(time?.tagName).toBe('TIME');
    expect(time?.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(time).toHaveAttribute('datetime');
  });

  it('draws the chart for the chosen timeframe and keeps its overlay choices', async () => {
    const user = userEvent.setup();
    const { client } = await start('two-open');
    const spy = vi.spyOn(client, 'getCandles');
    const panel = await screen.findByTestId('chart-panel');
    expect(await within(panel).findByTestId('price-chart-stub')).toBeInTheDocument();
    await user.click(within(panel).getByRole('radio', { name: '15m' }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tf: '15m' }));
    });
    await user.click(within(panel).getByRole('checkbox', { name: 'Fibonacci' }));
    await waitFor(() => {
      expect(spy.mock.calls.some(([query]) => (query.objects ?? '').includes('fib'))).toBe(true);
    });
    // The legend is the same information as text.
    const legend = await within(panel).findByTestId('chart-legend');
    await waitFor(() => {
      expect(legend).toHaveTextContent(/EMA 20 \d{4}\.\d{3}/);
    });
    expect(await within(panel).findByTestId('chart-levels')).toHaveTextContent(/PDH \d{4}\.\d{3}/);
  });
});
