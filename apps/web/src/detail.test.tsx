import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QUALITY_GROUPS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { mockSignalId } from './mocks/signals';
import { renderLoggedIn } from './test-utils';

/** Opens the detail page of a simulated signal and waits for its header. */
async function open(seq: number, options: Parameters<typeof renderLoggedIn>[1] = {}) {
  const app = await renderLoggedIn(`/signals/${mockSignalId(seq)}`, options);
  await screen.findByTestId('detail-header');
  return app;
}

const text = (testId: string) => screen.getByTestId(testId).textContent;
const events = () =>
  within(screen.getByTestId('detail-timeline'))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-testid')?.replace('timeline-', ''));

describe('the detail of a loss (scenario E8)', () => {
  it('has the header of 05_UI_Spec section 5: id, side, strategy and version, strategy status, mode, grade', async () => {
    await open(40);
    expect(screen.getByRole('heading', { name: 'Signal detail', level: 1 })).toBeInTheDocument();
    expect(text('detail-id')).toBe('S-0040');
    expect(text('detail-side')).toBe('SELL');
    expect(text('detail-strategy')).toBe('Liquidity Sweep Reversal v0.1.0');
    expect(text('detail-strategy-status')).toBe('FORWARD-TEST');
    expect(text('detail-mode')).toBe('SIMULATED');
    expect(text('detail-grade')).toMatch(/^(Moderate|Strong|Very strong) \d+$/);
    expect(document.title).toBe('Signal S-0040 · VM Gold Signal');
  });

  it('shows every level with 3 decimals, the risk and the exit profile', async () => {
    await open(40);
    expect(text('detail-entry')).toBe('4021.600');
    expect(text('detail-stop')).toBe('4027.700');
    expect(text('detail-tp1')).toBe('4015.500');
    expect(text('detail-tp2')).toBe('4009.400');
    expect(text('detail-risk')).toBe('6.100 USD');
    expect(text('detail-exit-profile')).toContain('Close 50% at TP1');
  });

  it('has the result block: badge, net R, exit price and reason, duration, MFE, MAE, targets, cost', async () => {
    await open(40);
    const result = within(screen.getByTestId('detail-result'));
    expect(result.getByTestId('detail-result-badge')).toHaveTextContent('Loss');
    expect(result.getByTestId('detail-net-r')).toHaveTextContent('-1.04R');
    expect(result.getByTestId('detail-exit-price')).toHaveTextContent('4027.700');
    expect(result.getByTestId('detail-exit-reason')).toHaveTextContent('Stop loss');
    expect(result.getByTestId('detail-duration')).toHaveTextContent('15 min');
    expect(result.getByTestId('detail-mfe').textContent).toMatch(/^\+0\.\d\dR$/);
    expect(result.getByTestId('detail-mae').textContent).toMatch(/^-1\.0\dR$/);
    expect(result.getByTestId('detail-tp1-reached')).toHaveTextContent('No');
    expect(result.getByTestId('detail-tp2-reached')).toHaveTextContent('No');
    expect(result.getByTestId('detail-cost')).toHaveTextContent('+0.04R');
    expect(result.queryByTestId('detail-ambiguous')).toBeNull();
  });

  it('lists the events in the order they happened', async () => {
    await open(40);
    expect(events()).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'SL_HIT',
      'AUTOPSY_PRELIMINARY',
      'AUTOPSY_FINAL',
    ]);
    const exit = within(screen.getByTestId('timeline-SL_HIT'));
    expect(exit.getByText(/Stop hit/)).toBeInTheDocument();
    expect(exit.getByText(/4027\.700/)).toBeInTheDocument();
    expect(exit.getByText('Stop loss')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('timeline-AUTOPSY_FINAL')).getByText('No follow-through'),
    ).toBeInTheDocument();
  });

  it('has the review: status, primary cause with its category, the groups that were weak, what price did next', async () => {
    await open(40);
    const review = within(screen.getByTestId('detail-autopsy'));
    expect(review.getByTestId('detail-autopsy-status')).toHaveTextContent('FINAL');
    expect(review.getByTestId('detail-autopsy-cause')).toHaveTextContent('No follow-through');
    expect(review.getByTestId('detail-autopsy-category')).toHaveTextContent('Setup failure');
    // the rule and the numbers behind the cause
    expect(review.getByText(/never moved 0\.3R/)).toBeInTheDocument();
    expect(review.getByText(/max favourable R 0\.\d+, limit R 0\.3/)).toBeInTheDocument();
    expect(
      within(review.getByTestId('detail-autopsy-weak')).getByText('Trigger and momentum: WEAK'),
    ).toBeInTheDocument();
    expect(review.getByTestId('detail-autopsy-counterfactual')).toHaveTextContent(
      'Price did not reach TP1 in the hour after the close.',
    );
    expect(review.queryByTestId('detail-autopsy-pending')).toBeNull();
    expect(
      review.getByText('Heuristic attribution; judge strategy by the statistics in Analytics.'),
    ).toBeInTheDocument();
  });

  it('shows the explanation as it was created, one row for each of the seven evidence groups, and the evidence', async () => {
    await open(40);
    const why = within(screen.getByTestId('detail-why'));
    for (const key of QUALITY_GROUPS) {
      expect(why.getByTestId(`signal-why-group-${key}`)).toBeInTheDocument();
      expect(why.getByTestId(`signal-why-state-${key}`)).toBeInTheDocument();
    }
    // the sweep reversal trades against the 1h trend: that group was weak
    expect(why.getByTestId('signal-why-state-trend')).toHaveTextContent('WEAK');
    expect(screen.getByTestId('detail-evidence')).toHaveTextContent('Insufficient evidence');
  });

  it('keeps the raw snapshot closed until it is opened, then shows its JSON', async () => {
    const user = userEvent.setup();
    await open(40);
    const snapshot = within(screen.getByTestId('detail-snapshot'));
    expect(snapshot.queryByTestId('detail-snapshot-json')).toBeNull();
    await user.click(snapshot.getByRole('button', { name: /Every feature at the moment/ }));
    const json = await snapshot.findByTestId('detail-snapshot-json');
    expect(json.textContent).toContain('"indicators"');
    expect(json.textContent).toContain('"rsi14"');
  });

  it('shows the chart around the trade with the same information as text', async () => {
    await open(40);
    expect(screen.getByTestId('detail-chart-section')).toBeInTheDocument();
    await waitFor(() => {
      expect(text('detail-chart-legend')).toMatch(/\d+ candles of 5 minutes\./);
    });
    const legend = text('detail-chart-legend');
    expect(legend).toContain(
      'S-0040 SELL: entry 4021.600, stop 4027.700, TP1 4015.500, TP2 4009.400',
    );
    expect(legend).toContain('Exit: Stop at 4027.700 (Stop loss).');
    // 60 candles before, the trade (15 minutes: 3 candles + the entry candle) and 60 after
    const count = Number(/(\d+) candles of 5 minutes/.exec(legend)?.[1]);
    expect(count).toBeGreaterThanOrEqual(121);
    expect(count).toBeLessThanOrEqual(126);
  });
});

describe('the detail of other results', () => {
  it('a win: TP1 and TP2 reached, the stop moved to entry, and no review', async () => {
    await open(41);
    expect(text('detail-result-badge')).toBe('Win');
    expect(text('detail-net-r')).toBe('+1.47R');
    expect(text('detail-tp1-reached')).toBe('Yes');
    expect(text('detail-tp2-reached')).toBe('Yes');
    expect(events()).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'TP2_HIT',
    ]);
    expect(screen.getByTestId('detail-autopsy-none')).toHaveTextContent(
      'A full win is not reviewed',
    );
    expect(screen.queryByTestId('detail-autopsy-cause')).toBeNull();
  });

  it('a partial win: stopped at entry after TP1, and reviewed', async () => {
    await open(39);
    expect(text('detail-result-badge')).toBe('Partial win');
    expect(text('detail-exit-reason')).toBe('Stopped at entry after TP1');
    expect(events()).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'SL_HIT',
      'AUTOPSY_PRELIMINARY',
      'AUTOPSY_FINAL',
    ]);
    expect(text('detail-autopsy-cause')).toBe('Normal loss');
  });

  it('a loss with several causes lists the supporting ones with their numbers', async () => {
    await open(10);
    expect(text('detail-autopsy-cause')).toBe('News shock');
    expect(text('detail-autopsy-category')).toBe('Market event');
    const supporting = within(screen.getByTestId('detail-autopsy-supporting'));
    expect(supporting.getByText(/Spread and slippage cost/)).toBeInTheDocument();
    expect(supporting.getByText(/cost R 0\.25/)).toBeInTheDocument();
  });

  it('a time exit has its own exit reason', async () => {
    await open(5);
    expect(text('detail-result-badge')).toBe('Time exit');
    expect(text('detail-exit-reason')).toBe('Time stop');
    expect(text('detail-duration')).toBe('2 h');
    expect(text('detail-autopsy-cause')).toBe('Time decay');
  });

  it('shows the ambiguous flag of a result where stop and target were crossed in the same tick', async () => {
    await open(17);
    expect(screen.getByTestId('detail-ambiguous')).toHaveTextContent('Ambiguous');
  });

  it('a cancelled signal and a data-invalid one say they are not counted, and have no result in R or review', async () => {
    await open(11);
    expect(text('detail-result-badge')).toBe('Cancelled');
    expect(text('detail-result-note')).toContain('not counted in the statistics');
    expect(screen.queryByTestId('detail-net-r')).toBeNull();
    expect(text('detail-exit-price')).toBe('\u2013');
    expect(text('detail-autopsy-none')).toContain('cancelled or data-invalid');
    expect(events()).toEqual(['CREATED', 'ALERT_QUEUED', 'CANCELLED']);
  });

  it('a data-invalid signal explains the feed gap', async () => {
    await open(29);
    expect(text('detail-result-badge')).toBe('Data invalid');
    expect(text('detail-result-note')).toContain('feed gap longer than 60 seconds');
    expect(text('detail-exit-reason')).toBe('Feed gap longer than 60 s');
  });

  it('an open signal shows its working state, not a result, and the review that will come', async () => {
    await open(42);
    expect(text('detail-result-badge')).toBe('Open');
    expect(screen.getByTestId('detail-current-stop')).toHaveTextContent('4010.900');
    expect(events()).toEqual(['CREATED', 'ALERT_QUEUED']);
    expect(text('detail-autopsy-none')).toBe('The review runs when the signal closes.');
    expect(text('detail-chart-legend')).toContain('Still open.');
  });

  it('an open signal after TP1 shows the events so far', async () => {
    await open(42, { scenario: 'tp1-hit' });
    expect(text('detail-result-badge')).toBe('Open (TP1 hit)');
    expect(events()).toEqual(['CREATED', 'ALERT_QUEUED', 'TP1_HIT', 'STOP_MOVED_TO_ENTRY']);
  });
});

describe('a pruned snapshot (scenario E9)', () => {
  it('says that retention removed it, and the rest of the page stays', async () => {
    await open(1);
    expect(text('detail-snapshot-pruned')).toBe(
      'Snapshot removed by retention; summary above is kept.',
    );
    expect(within(screen.getByTestId('detail-snapshot')).queryByRole('button')).toBeNull();
    // the summary of the signal is still all there
    expect(text('detail-id')).toBe('S-0001');
    expect(text('detail-result-badge')).toBe('Loss');
    expect(screen.getByTestId('detail-autopsy-cause')).toBeInTheDocument();
    expect(screen.getByTestId('detail-why')).toBeInTheDocument();
    expect(events().length).toBeGreaterThan(2);
  });
});

describe('a signal that is not there', () => {
  it('says so, keeps the heading and links back to the list', async () => {
    await renderLoggedIn('/signals/00000000-0000-4000-8000-ffffffffffff');
    expect(await screen.findByTestId('detail-not-found')).toHaveTextContent('Signal not found');
    expect(screen.getByRole('heading', { name: 'Signal detail', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to signals' })).toHaveAttribute(
      'href',
      '/signals',
    );
    expect(screen.queryByTestId('detail-header')).toBeNull();
  });
});

describe('the review turns final by itself (scenario E8)', () => {
  it('is preliminary at the close, with no counterfactual, and final 60 minutes later', async () => {
    const clock = { ms: Date.now() };
    const { emit } = await open(42, { scenario: 'review-pending', now: () => new Date(clock.ms) });
    const review = () => within(screen.getByTestId('detail-autopsy'));
    expect(review().getByTestId('detail-autopsy-status')).toHaveTextContent('PRELIMINARY');
    expect(review().getByTestId('detail-autopsy-pending')).toHaveTextContent(
      'final review follows 60 minutes later',
    );
    expect(review().getByTestId('detail-autopsy-counterfactual')).toHaveTextContent(
      'Not known yet',
    );
    expect(events()).toEqual(['CREATED', 'ALERT_QUEUED', 'SL_HIT', 'AUTOPSY_PRELIMINARY']);

    // the loss closed 35 minutes ago: 26 minutes later the hour has passed
    clock.ms += 26 * 60_000;
    emit({ event: 'resync', data: {} });
    await waitFor(() => {
      expect(review().getByTestId('detail-autopsy-status')).toHaveTextContent('FINAL');
    });
    expect(review().queryByTestId('detail-autopsy-pending')).toBeNull();
    expect(review().getByTestId('detail-autopsy-counterfactual')).toHaveTextContent(
      'did not reach TP1',
    );
    expect(events().at(-1)).toBe('AUTOPSY_FINAL');
  });
});
