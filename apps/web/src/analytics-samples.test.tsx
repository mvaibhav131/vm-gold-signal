import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DriftRow,
  FailuresResponse,
  GroupEffectivenessRow,
  MonthlyRow,
  OverviewResponse,
} from '@vmgs/contracts';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { DRIFT_CHIPS, DriftTable } from './analytics/DriftPanel';
import { FailureView } from './analytics/FailureAnalysis';
import { GroupMatrix, GroupView } from './analytics/GroupEffectiveness';
import { KpiGrid } from './analytics/KpiCards';
import { MonthlyTable } from './analytics/MonthlyTable';
import { AppProviders } from './AppProviders';
import { createMockClient } from './mocks/mockClient';
import { memoryStorage } from './test-utils';

// The rules of the sample size (30 results for a percentage, 100 for no label) are tested at
// their exact edges here, on components that are given hand-made data: the simulated results of
// the preview never have a table cell of exactly 29, 30, 99 or 100 results.

function client() {
  return createMockClient({ storage: memoryStorage(), latencyMs: 0, scenario: 'wait' });
}

const inApp = (ui: ReactElement) => render(<AppProviders client={client()}>{ui}</AppProviders>);

const cellsOf = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent);

describe('monthly table: the sample rules at their edges', () => {
  const month = (
    name: string,
    wins: number,
    losses: number,
    winRate: number | null,
  ): MonthlyRow => ({
    month: name,
    generated: wins + losses,
    resolvedValid: wins + losses,
    wins,
    partials: 0,
    losses,
    timeExits: 0,
    cancelled: 0,
    dataInvalid: 0,
    winRate,
    netR: 1.5,
    profitFactor: 1.2,
  });

  it('shows no percentage at 29 valid results, one at 30, and "low sample" until 99', () => {
    inApp(
      <MonthlyTable
        rows={[
          month('2026-01', 15, 14, null),
          month('2026-02', 15, 15, 0.5),
          month('2026-03', 55, 44, 0.556),
          month('2026-04', 55, 45, 0.55),
        ]}
      />,
    );
    const text = (name: string) => cellsOf(screen.getByTestId(`monthly-row-${name}`))[9];
    expect(text('2026-01')).toBe('–Insufficient evidence');
    expect(text('2026-02')).toBe('50% low sample');
    expect(text('2026-03')).toBe('56% low sample');
    // 100 valid results: no label
    expect(text('2026-04')).toBe('55%');
  });
});

describe('failure analysis: the shares at their edge', () => {
  const failures = (first: number, second: number): FailuresResponse => ({
    causes: [
      { code: 'NORMAL_LOSS', category: 'SETUP_FAILURE', n: first, share: 0.5, sumR: -4 },
      { code: 'NO_FOLLOW_THROUGH', category: 'SETUP_FAILURE', n: second, share: 0.5, sumR: -2 },
    ],
    weakGroups: [
      { group: 'trend', n: 6, share: 0.2 },
      { group: 'volatility', n: 2, share: 0.07 },
    ],
  });

  it('shows a share at 30 reviewed results and no share at 29', () => {
    const view = inApp(<FailureView data={failures(15, 14)} />);
    expect(screen.getByTestId('failure-total')).toHaveTextContent('29 reviewed results');
    expect(screen.getByTestId('failure-total')).toHaveTextContent('Fewer than 30');
    expect(screen.getByTestId('failure-causes').textContent).not.toContain('%');
    expect(screen.getByTestId('weak-groups').textContent).not.toContain('%');
    view.unmount();

    inApp(<FailureView data={failures(15, 15)} />);
    expect(screen.getByTestId('failure-total')).toHaveTextContent('30 reviewed results');
    expect(screen.getByTestId('failure-total')).not.toHaveTextContent('Fewer than 30');
    expect(cellsOf(screen.getByTestId('failure-row-NORMAL_LOSS'))[3]).toBe('50%');
    expect(cellsOf(screen.getByTestId('weak-group-trend'))[2]).toBe('20%');
  });

  it('draws each bar against the biggest count of its table', () => {
    inApp(<FailureView data={failures(9, 3)} />);
    const width = (testId: string) =>
      screen.getByTestId(testId).querySelector<HTMLElement>('.bar-fill')?.style.width;
    expect(width('failure-row-NORMAL_LOSS')).toBe('100%');
    expect(width('failure-row-NO_FOLLOW_THROUGH')).toBe('33.3%');
    expect(width('weak-group-trend')).toBe('100%');
    expect(width('weak-group-volatility')).toBe('33.3%');
  });

  it('says so when nothing was reviewed', () => {
    inApp(<FailureView data={{ causes: [], weakGroups: [] }} />);
    expect(screen.getByTestId('failure-causes')).toHaveTextContent('No reviewed results');
  });
});

describe('evidence groups: the sample notes at their edges', () => {
  const row = (
    state: GroupEffectivenessRow['state'],
    n: number,
    winRate: number | null,
  ): GroupEffectivenessRow => ({
    strategy: 'trend_pullback',
    group: 'trend',
    state,
    n,
    wins: Math.round(n / 2),
    winRate,
    ci95: winRate === null ? null : [0.3, 0.7],
    expectancyR: 0.1,
  });

  it('says "insufficient evidence" at 29, "low sample" from 30 to 99 and nothing at 100', () => {
    inApp(
      <GroupMatrix
        rows={[
          row('STRONG', 29, null),
          row('OK', 30, 0.5),
          row('WEAK', 99, 0.4),
          row('FAIL', 100, 0.6),
        ]}
      />,
    );
    const cell = (state: string) => screen.getByTestId(`group-cell-trend-${state}`);
    expect(cell('STRONG')).toHaveTextContent('n = 29, insufficient evidence');
    expect(cell('STRONG').textContent).not.toContain('%');
    expect(cell('OK')).toHaveTextContent('n = 30, low sample');
    expect(cell('OK')).toHaveTextContent('50%');
    expect(cell('OK')).toHaveTextContent('95% CI 30–70%');
    expect(cell('WEAK')).toHaveTextContent('n = 99, low sample');
    expect(cell('FAIL')).toHaveTextContent('n = 100');
    expect(cell('FAIL').textContent).not.toMatch(/low sample|insufficient/);
    expect(cell('FAIL')).toHaveTextContent('60%');
  });

  it('adds the column "Not applicable" only when a result had it', () => {
    const view = inApp(<GroupMatrix rows={[row('STRONG', 40, 0.5), row('NA', 0, null)]} />);
    expect(screen.queryByRole('columnheader', { name: 'Not applicable at entry' })).toBeNull();
    view.unmount();
    inApp(<GroupMatrix rows={[row('STRONG', 40, 0.5), row('NA', 3, null)]} />);
    expect(
      screen.getByRole('columnheader', { name: 'Not applicable at entry' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('group-cell-trend-NA')).toHaveTextContent('n = 3');
  });

  it('falls back to the first strategy when the one that was chosen has no results', async () => {
    const user = userEvent.setup();
    const sweep: GroupEffectivenessRow = { ...row('STRONG', 8, null), strategy: 'sweep_reversal' };
    const both = [row('STRONG', 5, null), sweep];
    const api = client();
    const view = render(
      <AppProviders client={api}>
        <GroupView rows={both} />
      </AppProviders>,
    );
    expect(screen.getByRole('combobox', { name: 'Strategy' })).toHaveValue('Trend Pullback');
    await user.click(screen.getByRole('combobox', { name: 'Strategy' }));
    await user.click(
      await screen.findByRole('option', { name: 'Liquidity Sweep Reversal', hidden: true }),
    );
    expect(screen.getByRole('combobox', { name: 'Strategy' })).toHaveValue(
      'Liquidity Sweep Reversal',
    );
    expect(screen.getByTestId('group-cell-trend-STRONG')).toHaveTextContent('n = 8');

    // another scope: the strategy that was chosen has no result there
    view.rerender(
      <AppProviders client={api}>
        <GroupView rows={[row('STRONG', 5, null)]} />
      </AppProviders>,
    );
    expect(screen.getByRole('combobox', { name: 'Strategy' })).toHaveValue('Trend Pullback');
    expect(screen.getByTestId('group-cell-trend-STRONG')).toHaveTextContent('n = 5');
  });

  it('says so when there is no result at all', () => {
    inApp(<GroupView rows={[]} />);
    expect(screen.getByTestId('group-effectiveness')).toHaveTextContent('No valid results');
  });
});

describe('drift: every status has its own colour as well as its words', () => {
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
      evidenceCi95: null,
      status: 'INSUFFICIENT_DATA',
    },
  ];

  it('is green within the range, amber below it, blue above it and grey without data', () => {
    expect(DRIFT_CHIPS.WITHIN_RANGE.tone).toBe('positive');
    expect(DRIFT_CHIPS.BELOW_RANGE.tone).toBe('warning');
    expect(DRIFT_CHIPS.ABOVE_RANGE.tone).toBe('info');
    expect(DRIFT_CHIPS.INSUFFICIENT_DATA.tone).toBe('neutral');
    inApp(<DriftTable rows={rows} statuses={{}} />);
    const colour = (strategy: string) =>
      screen.getByTestId(`drift-status-${strategy}`).getAttribute('style') ?? '';
    expect(colour('sweep_reversal')).toContain('positive');
    expect(colour('trend_pullback')).toContain('warning');
    expect(colour('squeeze_retest')).toContain('info');
    expect(colour('trendline_retest')).toContain('gray');
    // each one also says what it is, with its own words
    const words = rows.map(
      (r) =>
        within(screen.getByTestId(`drift-row-${r.strategy}`)).getByTestId(
          `drift-status-${r.strategy}`,
        ).textContent,
    );
    expect(new Set(words).size).toBe(4);
  });
});

describe('key numbers: a fall is red', () => {
  it('colours the maximum drawdown as a loss, and leaves a drawdown of zero plain', async () => {
    const overview: OverviewResponse = await client().getOverview({ scope: 'FORWARD' });
    const view = inApp(<KpiGrid overview={overview} />);
    const drawdown = () => screen.getByTestId('kpi-max-drawdown');
    expect(drawdown().querySelector('.text-negative')).toHaveTextContent('-3.68R');
    expect(screen.getByTestId('kpi-net-r').querySelector('.text-positive')).toHaveTextContent(
      '+6.34R',
    );
    view.unmount();
    inApp(<KpiGrid overview={{ ...overview, maxDrawdownR: 0 }} />);
    expect(drawdown()).toHaveTextContent('0.00R');
    expect(drawdown().querySelector('.text-negative')).toBeNull();
  });
});
