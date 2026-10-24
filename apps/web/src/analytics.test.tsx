import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DriftRow } from '@vmgs/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DriftTable } from './analytics/DriftPanel';
import { monthText } from './analytics/MonthlyTable';
import type { ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
import { memoryStorage, renderApp } from './test-utils';

/** The clock of the preview. The simulated history is relative to it, so the months below never change. */
const NOW = new Date('2026-10-23T12:00:00Z');

type Override = (mock: ApiClient) => Partial<ApiClient>;

/** Opens Analytics in the preview state without an open signal (41 signals), logged in. */
async function open(route = '/analytics', override: Override = () => ({})) {
  const mock = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 600_000,
    signalUpdateIntervalMs: 600_000,
    scenario: 'wait',
    now: () => NOW,
  });
  await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
  const client: ApiClient = { ...mock, ...override(mock) };
  const { router } = renderApp({ client, route });
  await screen.findByTestId('kpi-generated');
  return { client, router, user: userEvent.setup() };
}

const kpi = (name: string) => screen.getByTestId(`kpi-${name}`);
const cellsOf = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent);

/** Picks an option of a Mantine select by its label. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option, hidden: true }));
}

async function switchToBacktest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: 'Backtest out-of-sample' }));
  await waitFor(() => {
    expect(kpi('generated')).toHaveTextContent('318');
  });
}

describe('the analytics page (scenario E10)', () => {
  it('has the sections of the spec in order, with the forward paper results as the first scope', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Analytics', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Key numbers',
      'Month by month',
      'Equity curve',
      'Where it works and where it does not',
      'Why signals failed',
      'Which evidence groups matter',
      'Does a higher score win more often?',
      'Is it still behaving like the backtest?',
      'Do headlines go with bigger gold moves?',
    ]);
    expect(screen.getByRole('radio', { name: 'Forward paper' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Backtest out-of-sample' })).not.toBeChecked();
    expect(screen.getByTestId('scope-note')).toHaveTextContent('generated in real time');
    expect(document.title).toContain('Analytics');
  });

  it('shows the key numbers of the forward results, equal to what the API sent', async () => {
    const { client } = await open();
    const overview = await client.getOverview({ scope: 'FORWARD' });
    expect(kpi('generated')).toHaveTextContent(String(overview.generated));
    expect(kpi('tracked')).toHaveTextContent(String(overview.resolvedValid));
    // 39 valid results: a percentage with its interval, and the low-sample label (under 100)
    expect(kpi('generated')).toHaveTextContent('41');
    expect(kpi('tracked')).toHaveTextContent('39');
    expect(kpi('tracked')).toHaveTextContent('Cancelled 1 and data-invalid 1 are counted apart');
    expect(kpi('win-rate')).toHaveTextContent('54%');
    expect(kpi('win-rate')).toHaveTextContent('95% CI 39–68%, n = 39');
    expect(kpi('win-rate')).toHaveTextContent('Low sample');
    expect(kpi('net-r')).toHaveTextContent('+6.34R');
    expect(kpi('expectancy')).toHaveTextContent('+0.16R');
    expect(kpi('profit-factor')).toHaveTextContent('1.38');
    expect(kpi('max-drawdown')).toHaveTextContent('-3.68R');
    expect(kpi('tp1-rate')).toHaveTextContent('51%');
    expect(kpi('tp2-rate')).toHaveTextContent('36%');
  });

  it('shows no percentage under 30 valid results, only the counts and the words', async () => {
    const { client } = await open();
    const { KpiGrid } = await import('./analytics/KpiCards');
    const few = await client.getOverview({ strategy: 'sweep_reversal' });
    expect(few.resolvedValid).toBe(11);
    render(
      <AppProviders client={client}>
        <KpiGrid overview={few} />
      </AppProviders>,
    );
    const grids = screen.getAllByTestId('kpi-win-rate');
    const own = grids.at(-1);
    if (!own) throw new Error('no card');
    expect(own).toHaveTextContent('Insufficient evidence');
    expect(own).toHaveTextContent('11 valid results; a percentage needs 30');
    expect(own).not.toHaveTextContent('%');
    for (const name of ['tp1-rate', 'tp2-rate']) {
      const card = screen.getAllByTestId(`kpi-${name}`).at(-1);
      expect(card).toHaveTextContent('Insufficient evidence');
      expect(card).not.toHaveTextContent('%');
    }
  });

  it('opens the backtest from the address bar, and the switch changes every block and the address', async () => {
    const { router, user } = await open();
    const forwardMonths = screen.getAllByTestId(/^monthly-row-/).length;
    await switchToBacktest(user);
    expect(router.state.location.search).toBe('?scope=BACKTEST_OOS');
    expect(screen.getByRole('radio', { name: 'Backtest out-of-sample' })).toBeChecked();
    expect(screen.getByTestId('scope-note')).toHaveTextContent('not used to build them');
    expect(kpi('tracked')).toHaveTextContent('302');
    // 302 valid results: a percentage with its interval and no low-sample label (100 or more)
    expect(kpi('win-rate')).toHaveTextContent('54%');
    expect(kpi('win-rate')).toHaveTextContent('95% CI 49–60%, n = 302');
    expect(kpi('win-rate')).not.toHaveTextContent('Low sample');
    expect(kpi('net-r')).toHaveTextContent('+34.90R');
    expect(kpi('max-drawdown')).toHaveTextContent('-12.52R');
    expect(await screen.findAllByTestId(/^monthly-row-/)).toHaveLength(12);
    expect(forwardMonths).not.toBe(12);
    expect(screen.getByTestId('equity-summary')).toHaveTextContent(
      '302 valid results. Now +34.90R',
    );

    await user.click(screen.getByRole('radio', { name: 'Forward paper' }));
    await waitFor(() => {
      expect(kpi('generated')).toHaveTextContent('41');
    });
    expect(router.state.location.search).toBe('');
  });

  it('opens on the backtest for a link with the scope, and on forward for a scope it does not know', async () => {
    await open('/analytics?scope=BACKTEST_OOS');
    expect(screen.getByRole('radio', { name: 'Backtest out-of-sample' })).toBeChecked();
    await waitFor(() => {
      expect(kpi('generated')).toHaveTextContent('318');
    });
  });

  it('falls back to forward for an unknown scope in the address', async () => {
    await open('/analytics?scope=LIVE');
    expect(screen.getByRole('radio', { name: 'Forward paper' })).toBeChecked();
    expect(kpi('generated')).toHaveTextContent('41');
  });
});

describe('monthly table', () => {
  it('has a row for each month with the counts of the API, and a win rate only where the API sent one', async () => {
    const { client } = await open();
    const { items } = await client.getMonthly({ scope: 'FORWARD' });
    expect(items.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(screen.getAllByTestId(/^monthly-row-/)).toHaveLength(4);
    for (const m of items) {
      const cells = cellsOf(screen.getByTestId(`monthly-row-${m.month}`));
      expect(cells.slice(0, 9), m.month).toEqual([
        monthText(m.month),
        String(m.generated),
        String(m.resolvedValid),
        String(m.wins),
        String(m.partials),
        String(m.losses),
        String(m.timeExits),
        String(m.cancelled),
        String(m.dataInvalid),
      ]);
      expect(items.reduce((sum, row) => sum + row.generated, 0)).toBe(41);
      // every month has fewer than 30 valid results here: a dash, and no percentage
      expect(cells[9], m.month).toBe('–Insufficient evidence');
      expect(cells[9]).not.toContain('%');
    }
    const july = cellsOf(screen.getByTestId('monthly-row-2026-07'));
    expect([july[1], july[2], july[10]]).toEqual(['7', '7', '+2.21R']);
  });

  it('answers "how many signals came each month and how many were proper": generated against properly tracked', async () => {
    await open();
    const august = cellsOf(screen.getByTestId('monthly-row-2026-08'));
    // 12 signals, 11 of them valid (one cancelled)
    expect([august[1], august[2], august[7]]).toEqual(['12', '11', '1']);
  });

  it('explains that most months show a dash, and scrolls inside its own box', async () => {
    await open();
    const section = screen.getByRole('region', { name: 'Monthly table, scrolls sideways' });
    expect(section).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/most win rates here are a dash/)).toBeInTheDocument();
  });

  it('backtest: twelve whole months, which add up to the key numbers', async () => {
    const { user } = await open();
    await switchToBacktest(user);
    const rows = await screen.findAllByTestId(/^monthly-row-/);
    expect(rows).toHaveLength(12);
    const sum = (index: number) =>
      rows.reduce((total, row) => total + Number(cellsOf(row)[index]), 0);
    expect(sum(1)).toBe(318);
    expect(sum(2)).toBe(302);
    expect(rows[0]).toHaveAttribute('data-testid', 'monthly-row-2025-07');
    expect(rows[11]).toHaveAttribute('data-testid', 'monthly-row-2026-06');
  });
});

describe('equity curve', () => {
  it('draws the curve and says the same in words, with the low-sample label for 39 results', async () => {
    await open();
    const chart = screen.getByTestId('equity-curve');
    expect(
      within(chart).getByRole('img', {
        name: /Equity curve in R: cumulative net R after each of 39 valid results, ending at \+6\.34R/,
      }),
    ).toBeInTheDocument();
    expect(within(chart).getByTestId('equity-summary')).toHaveTextContent(
      '39 valid results. Now +6.34R, highest +7.68R, lowest -1.05R.',
    );
    expect(chart).toHaveTextContent('Low sample');
    expect(chart.querySelectorAll('svg path')).toHaveLength(2);
  });

  it('is the same picture for the whole backtest, without the low-sample label', async () => {
    const { user } = await open();
    await switchToBacktest(user);
    const chart = await screen.findByTestId('equity-curve');
    await waitFor(() => {
      expect(within(chart).getByTestId('equity-summary')).toHaveTextContent('302 valid results');
    });
    expect(within(chart).getByTestId('equity-summary')).toHaveTextContent('Now +34.90R');
    // the curve ends at the net R of the key numbers
    expect(kpi('net-r')).toHaveTextContent('+34.90R');
    expect(chart).not.toHaveTextContent('Low sample');
  });
});

describe('breakdown', () => {
  it('has a tab for each of the seven dimensions and starts with the strategies', async () => {
    await open();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'Strategy',
      'Side',
      'Session',
      'Regime',
      'Volatility',
      'News condition',
      'Grade',
    ]);
    expect(screen.getByRole('tab', { name: 'Strategy' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('breakdown-strategy')).toBeInTheDocument();
  });

  it('loads a dimension only when its tab is opened', async () => {
    const getBreakdown = vi.fn();
    const { user } = await open('/analytics', (mock) => {
      getBreakdown.mockImplementation((query: Parameters<ApiClient['getBreakdown']>[0]) =>
        mock.getBreakdown(query),
      );
      return { getBreakdown };
    });
    await screen.findByTestId('breakdown-strategy');
    expect(getBreakdown.mock.calls.map(([query]) => (query as { by: string }).by)).toEqual([
      'strategy',
    ]);
    await user.click(screen.getByRole('tab', { name: 'Session' }));
    expect(await screen.findByTestId('breakdown-session')).toBeInTheDocument();
    expect(screen.queryByTestId('breakdown-strategy')).not.toBeInTheDocument();
    expect(getBreakdown.mock.calls.map(([query]) => (query as { by: string }).by)).toEqual([
      'strategy',
      'session',
    ]);
    // a session is a name
    expect(screen.getByTestId('breakdown-session')).toHaveTextContent(
      /London|Asia|Overlap|New York/,
    );
  });

  it('does not show the rows of another dimension while the one that was opened loads', async () => {
    const { user } = await open('/analytics', (mock) => ({
      getBreakdown: (query: Parameters<ApiClient['getBreakdown']>[0]) =>
        query.by === 'session'
          ? new Promise((resolve) => {
              setTimeout(() => {
                resolve(mock.getBreakdown(query));
              }, 150);
            })
          : mock.getBreakdown(query),
    }));
    await screen.findByTestId('breakdown-strategy');
    await user.click(screen.getByRole('tab', { name: 'Session' }));
    // no strategy rows under the Session tab, not even for a moment
    expect(screen.queryByTestId('breakdown-strategy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('breakdown-session')).not.toBeInTheDocument();
    expect(await screen.findByTestId('breakdown-session')).toBeInTheDocument();
    expect(screen.queryByTestId(/^breakdown-strategy/)).not.toBeInTheDocument();
  });

  it('forward: every strategy has fewer than 30 results, so counts, no percentage, and the insufficient-evidence label', async () => {
    await open();
    const row = await screen.findByTestId('breakdown-strategy-row-trend_pullback');
    const cells = cellsOf(row);
    expect(cells[0]).toBe('Trend Pullback');
    expect(cells[1]).toBe('24');
    expect(cells[3]).toBe('–Insufficient evidence');
    expect(row).toHaveTextContent('Insufficient evidence');
    expect(screen.getByTestId('breakdown-strategy').textContent).not.toContain('%');
    expect(screen.getByTestId('breakdown-strategy-row-squeeze_retest')).toHaveTextContent('4');
  });

  it('backtest: a percentage with its interval from 30 results, "Low sample" until 100', async () => {
    const { user } = await open();
    await switchToBacktest(user);
    const trend = await screen.findByTestId('breakdown-strategy-row-trend_pullback');
    await waitFor(() => {
      expect(trend).toHaveTextContent('55%');
    });
    expect(trend).toHaveTextContent('(95% CI 48–62%)');
    expect(trend).not.toHaveTextContent('Low sample');
    expect(trend).not.toHaveTextContent('Insufficient evidence');
    const squeeze = screen.getByTestId('breakdown-strategy-row-squeeze_retest');
    expect(squeeze).toHaveTextContent('55%');
    expect(squeeze).toHaveTextContent('(95% CI 43–66%)');
    expect(squeeze).toHaveTextContent('Low sample');
    const sweep = screen.getByTestId('breakdown-strategy-row-sweep_reversal');
    expect(sweep).toHaveTextContent('24');
    expect(sweep).not.toHaveTextContent('%');
    expect(sweep).toHaveTextContent('Insufficient evidence');
  });

  it('lists the biggest sample first, as the API sends the rows', async () => {
    const { client, user } = await open();
    await switchToBacktest(user);
    const { items } = await client.getBreakdown({ by: 'strategy', scope: 'BACKTEST_OOS' });
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId(/^breakdown-strategy-row-/)
          .map((row) => row.getAttribute('data-testid')),
      ).toEqual(items.map((item) => `breakdown-strategy-row-${item.key}`));
    });
  });
});

describe('failure analysis', () => {
  it('forward: 25 reviewed results are fewer than 30, so counts and net R but no share', async () => {
    await open();
    expect(await screen.findByTestId('failure-total')).toHaveTextContent(
      '25 reviewed results (every valid result that was not a clean win). Fewer than 30, so shares are not shown, only counts.',
    );
    const table = screen.getByTestId('failure-causes');
    const normal = cellsOf(within(table).getByTestId('failure-row-NORMAL_LOSS'));
    expect(normal[0]).toBe('Normal loss');
    expect(normal[1]).toBe('Setup failure');
    expect(normal[2]).toBe('9');
    expect(normal[3]).toBe('–Insufficient evidence');
    expect(normal[4]).toBe('-3.68R');
    expect(table.textContent).not.toContain('%');
    expect(within(table).getByTestId('failure-row-SPREAD_COST')).toHaveTextContent('Execution');
    expect(screen.getByTestId('weak-groups').textContent).not.toContain('%');
  });

  it('ranks the causes by count: the first row is the most frequent cause', async () => {
    await open();
    const table = await screen.findByTestId('failure-causes');
    const counts = within(table)
      .getAllByTestId(/^failure-row-/)
      .map((row) => Number(cellsOf(row)[2]));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(25);
    expect(screen.getByTestId('weak-group-trend')).toHaveTextContent('Trend');
  });

  it('backtest: shares appear from 30 reviewed results', async () => {
    const { client, user } = await open();
    await switchToBacktest(user);
    const { causes } = await client.getFailures({ scope: 'BACKTEST_OOS' });
    const reviewed = causes.reduce((sum, c) => sum + c.n, 0);
    expect(reviewed).toBeGreaterThanOrEqual(30);
    await waitFor(() => {
      expect(screen.getByTestId('failure-total')).toHaveTextContent(
        `${String(reviewed)} reviewed results`,
      );
    });
    expect(screen.getByTestId('failure-total')).not.toHaveTextContent('Fewer than 30');
    const first = causes[0];
    if (!first) throw new Error('no cause');
    expect(screen.getByTestId(`failure-row-${first.code}`)).toHaveTextContent(
      `${String(Math.round(first.share * 100))}%`,
    );
  });

  it('says that the attribution is a heuristic and lists the rule of each cause', async () => {
    await open();
    expect(screen.getByText(/Heuristic attribution/)).toBeInTheDocument();
    expect(screen.getByText(/not by one cause/)).toBeInTheDocument();
    const rules = await screen.findByTestId('failure-rules');
    expect(within(rules).getAllByRole('listitem', { hidden: true })).toHaveLength(9);
    expect(rules).toHaveTextContent('Spread and slippage cost at least 25% of the risk distance.');
  });
});

describe('evidence-group effectiveness', () => {
  it('forward: a matrix of the seven groups by their state at entry, with counts and no percentage', async () => {
    await open();
    const table = await screen.findByTestId('group-effectiveness');
    expect(within(table).getAllByTestId(/^group-row-/)).toHaveLength(7);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Evidence group',
      'Strong at entry',
      'OK at entry',
      'Weak at entry',
      'Fail at entry',
    ]);
    // the first strategy with results is shown; every cell has fewer than 30 results
    expect(screen.getByRole('combobox', { name: 'Strategy' })).toHaveValue('Trend Pullback');
    expect(table.textContent).not.toContain('%');
    expect(table.textContent).toContain('insufficient evidence');
    expect(screen.getByTestId('group-cell-trigger-STRONG')).toHaveTextContent(/n = \d+/);
  });

  it('backtest: percentages and intervals where a cell has 30 results or more, "low sample" until 100', async () => {
    const { user } = await open();
    await switchToBacktest(user);
    const cell = await screen.findByTestId('group-cell-trigger-STRONG');
    await waitFor(() => {
      expect(cell).toHaveTextContent('71%');
    });
    expect(cell).toHaveTextContent('n = 58, low sample');
    expect(cell).toHaveTextContent('95% CI');
  });

  it('can show another strategy', async () => {
    const { client, user } = await open('/analytics?scope=BACKTEST_OOS');
    await screen.findByTestId('group-effectiveness');
    await choose(user, 'Strategy', 'Squeeze Breakout and Retest');
    const { items } = await client.getGroupEffectiveness({ scope: 'BACKTEST_OOS' });
    const trend = items.filter((i) => i.strategy === 'squeeze_retest' && i.group === 'trend');
    const row = screen.getByTestId('group-row-trend');
    for (const item of trend) {
      expect(within(row).getByTestId(`group-cell-trend-${item.state}`)).toHaveTextContent(
        `n = ${String(item.n)}`,
      );
    }
    expect(trend.reduce((sum, i) => sum + i.n, 0)).toBe(64);
  });
});

describe('score calibration', () => {
  it('forward: six bands, each with the counts of the API and a percentage only where it sent one', async () => {
    const { client } = await open();
    const { items } = await client.getCalibration({ scope: 'FORWARD' });
    const rows = await screen.findAllByTestId(/^calibration-row-/);
    expect(rows).toHaveLength(6);
    items.forEach((item, i) => {
      const row = rows[i];
      if (!row) throw new Error('no row');
      const cells = cellsOf(row);
      expect(cells[0]).toBe(`${String(item.bandFrom)}–${String(item.bandTo)}`);
      expect(cells.slice(1, 3)).toEqual([String(item.n), String(item.wins)]);
      expect(row.textContent.includes('%'), `band ${String(item.bandFrom)}`).toBe(
        item.winRate !== null,
      );
    });
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'calibration-row-65-69',
      'calibration-row-70-74',
      'calibration-row-75-79',
      'calibration-row-80-84',
      'calibration-row-85-89',
      'calibration-row-90-100',
    ]);
  });

  it('backtest: a bar and a percentage for a band of 30 results or more, counts only below, an empty band is still listed', async () => {
    const { user } = await open();
    await switchToBacktest(user);
    const first = await screen.findByTestId('calibration-row-65-69');
    await waitFor(() => {
      expect(first).toHaveTextContent('45%');
    });
    expect(cellsOf(first).slice(1, 3)).toEqual(['53', '24']);
    expect(first.querySelectorAll('.bar-fill')).toHaveLength(1);
    expect(first.querySelector('.bar-fill')).toHaveStyle({ width: '45.3%' });
    const small = screen.getByTestId('calibration-row-80-84');
    expect(cellsOf(small).slice(1, 3)).toEqual(['22', '18']);
    expect(small).not.toHaveTextContent('%');
    expect(small).toHaveTextContent('Insufficient evidence');
    expect(small.querySelector('.bar-fill')).toBeNull();
    const empty = screen.getByTestId('calibration-row-90-100');
    expect(cellsOf(empty).slice(1, 3)).toEqual(['0', '0']);
    expect(empty).not.toHaveTextContent('%');
  });

  it('says that the score is not a probability', async () => {
    await open();
    expect(screen.getByText(/not a probability/)).toBeInTheDocument();
  });
});

describe('drift panel', () => {
  it('forward: every strategy has fewer than 30 results, so counts, a dash and the words "Insufficient data"', async () => {
    await open();
    const panel = await screen.findByTestId('drift-panel');
    const trend = cellsOf(within(panel).getByTestId('drift-row-trend_pullback'));
    expect(trend[0]).toBe('Trend Pullback');
    expect(trend[1]).toBe('Forward testing');
    expect(trend[2]).toBe('24 of 50');
    expect(trend[3]).toBe('–Insufficient evidence');
    expect(trend[4]).toContain('95% CI 48–62%');
    expect(trend[5]).toBe('Insufficient data');
    expect(within(panel).getByTestId('drift-row-sweep_reversal')).toHaveTextContent(
      'No backtest interval',
    );
    expect(within(panel).getAllByTestId(/^drift-status-/)).toHaveLength(3);
  });

  it('does not follow the scope switch: drift is about the forward results', async () => {
    const { user } = await open();
    const before = (await screen.findByTestId('drift-panel')).textContent;
    await switchToBacktest(user);
    expect(screen.getByTestId('drift-panel').textContent).toBe(before);
    expect(screen.getByTestId('outside-scope-note')).toHaveTextContent('do not follow the switch');
  });

  describe('every status', () => {
    const rows: DriftRow[] = [
      {
        strategy: 'trend_pullback',
        window: 50,
        n: 50,
        rollingWinRate: 0.4,
        evidenceCi95: [0.484, 0.617],
        status: 'BELOW_RANGE',
      },
      {
        strategy: 'sweep_reversal',
        window: 50,
        n: 40,
        rollingWinRate: 0.55,
        evidenceCi95: [0.484, 0.617],
        status: 'WITHIN_RANGE',
      },
      {
        strategy: 'squeeze_retest',
        window: 50,
        n: 35,
        rollingWinRate: 0.8,
        evidenceCi95: [0.484, 0.617],
        status: 'ABOVE_RANGE',
      },
      {
        strategy: 'trendline_retest',
        window: 50,
        n: 12,
        rollingWinRate: null,
        evidenceCi95: [0.45, 0.6],
        status: 'INSUFFICIENT_DATA',
      },
    ];

    function show(list: readonly DriftRow[]) {
      const client = createMockClient({ storage: memoryStorage(), latencyMs: 0, scenario: 'wait' });
      return render(
        <AppProviders client={client}>
          <DriftTable
            rows={list}
            statuses={{ trend_pullback: 'DRIFTED', sweep_reversal: 'PAUSED' }}
          />
        </AppProviders>,
      );
    }

    it('says in words where the rolling win rate is against the backtest range', () => {
      show(rows);
      const text = (strategy: string) => screen.getByTestId(`drift-status-${strategy}`).textContent;
      expect(text('trend_pullback')).toBe('Below the backtest range');
      expect(text('sweep_reversal')).toBe('Within the backtest range');
      expect(text('squeeze_retest')).toBe('Above the backtest range');
      expect(text('trendline_retest')).toBe('Insufficient data');
    });

    it('shows the rolling rate only where the API sent one, and the strategy status next to it', () => {
      show(rows);
      const trend = cellsOf(screen.getByTestId('drift-row-trend_pullback'));
      expect(trend.slice(1, 4)).toEqual(['Drifted', '50 of 50', '40%']);
      expect(cellsOf(screen.getByTestId('drift-row-sweep_reversal'))[1]).toBe('Paused');
      // no status known for this strategy: a dash
      expect(cellsOf(screen.getByTestId('drift-row-squeeze_retest'))[1]).toBe('–');
      const insufficient = cellsOf(screen.getByTestId('drift-row-trendline_retest'));
      expect(insufficient[3]).toBe('–Insufficient evidence');
      expect(insufficient[2]).toBe('12 of 50');
      expect(screen.getByTestId('drift-row-trendline_retest').textContent).not.toMatch(/\d+% *$/);
    });

    it('draws the backtest range as a band with a mark where the rolling rate is', () => {
      show(rows);
      const trend = screen.getByTestId('drift-row-trend_pullback');
      expect(trend.querySelector('.range-band')).toHaveStyle({ width: '13.3%' });
      expect(trend.querySelector('.range-mark')).toHaveStyle({ left: '40%' });
      // no rolling rate yet: the band alone
      const none = screen.getByTestId('drift-row-trendline_retest');
      expect(none.querySelector('.range-band')).not.toBeNull();
      expect(none.querySelector('.range-mark')).toBeNull();
    });

    it('says so when no strategy has results to compare', () => {
      show([]);
      expect(screen.getByTestId('drift-panel')).toHaveTextContent(
        'No strategy has forward results',
      );
    });
  });
});

describe('news impact', () => {
  it('has a row for each topic and level, in plain words', async () => {
    await open();
    const table = await screen.findByTestId('news-impact');
    expect(within(table).getAllByTestId(/^news-impact-row-/)).toHaveLength(17);
    const fed = cellsOf(within(table).getByTestId('news-impact-row-FED_RATES-HIGH'));
    expect(fed[0]).toBe('Fed and interest rates');
    expect(fed[1]).toBe('High');
    expect(fed.slice(2, 4)).toEqual(['142', '61']);
    expect(fed[4]).toContain('43%');
    expect(fed[4]).toContain('(95% CI');
    expect(fed[5]).toBe('19%');
    expect(fed[6]).toBe('2.26×');
  });

  it('shows no percentage and no comparison for a topic with fewer than 30 headlines', async () => {
    const { client } = await open();
    const { items } = await client.getNewsImpact();
    const small = items.filter((i) => i.n < 30);
    expect(small.length).toBeGreaterThan(0);
    for (const item of small) {
      const row = screen.getByTestId(`news-impact-row-${item.topic}-${item.impact}`);
      expect(row.textContent, `${item.topic} ${item.impact}`).not.toContain('%');
      expect(row.textContent).not.toContain('×');
      expect(row).toHaveTextContent('Insufficient evidence');
    }
    // 30 to 99 headlines carry the low-sample label
    const low = items.find((i) => i.n >= 30 && i.n < 100);
    if (!low) throw new Error('no low-sample row');
    expect(screen.getByTestId(`news-impact-row-${low.topic}-${low.impact}`)).toHaveTextContent(
      'Low sample',
    );
  });

  it('only talks about association, never about cause', async () => {
    await open();
    const section = (await screen.findByTestId('news-impact')).closest('section');
    if (!section) throw new Error('no section');
    expect(section).toHaveTextContent('an association, not a cause');
    expect(screen.getByTestId('page-analytics').textContent).not.toMatch(
      /\b(caused|because of|due to the headline)\b/i,
    );
  });

  it('does not follow the scope switch', async () => {
    const { user } = await open();
    const before = (await screen.findByTestId('news-impact')).textContent;
    await switchToBacktest(user);
    expect(screen.getByTestId('news-impact').textContent).toBe(before);
  });
});

describe('when a block cannot be loaded', () => {
  it('shows the error of that block with a retry button and keeps the others', async () => {
    const { user } = await open('/analytics', (mock) => ({
      getMonthly: vi
        .fn((query: Parameters<ApiClient['getMonthly']>[0]) => mock.getMonthly(query))
        .mockRejectedValueOnce(new Error('down')),
    }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the monthly table');
    expect(kpi('generated')).toHaveTextContent('41');
    expect(await screen.findByTestId('equity-curve')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByTestId(/^monthly-row-/)).toHaveLength(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
