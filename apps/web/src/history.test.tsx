import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderLoggedIn } from './test-utils';

const rowIds = () =>
  screen
    .getAllByTestId(/^history-row-/)
    .map((row) => Number(row.getAttribute('data-testid')?.replace('history-row-', '')));

/** Opens the history and waits for the table (and for a row that is certainly in it). */
async function open(route = '/signals', firstRow = 43) {
  const app = await renderLoggedIn(route);
  await screen.findByTestId('history-table');
  await screen.findByTestId(`history-row-${String(firstRow)}`);
  return app;
}

/** Picks an option of a Mantine select by its label. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option, hidden: true }));
}

describe('the signal history (scenario E7)', () => {
  it('shows the filters, the summary of the whole list and the newest signals first', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Signals', level: 1 })).toBeInTheDocument();
    for (const label of [
      'From',
      'To',
      'Result',
      'Strategy',
      'Side',
      'Session',
      'Regime',
      'Failure cause',
      'Grade',
    ]) {
      expect(screen.getByLabelText(label, { selector: 'input' })).toBeInTheDocument();
    }
    const summary = screen.getByTestId('history-summary');
    expect(within(summary).getByTestId('summary-signals')).toHaveTextContent('43');
    expect(within(summary).getByTestId('summary-valid')).toHaveTextContent('39');
    // 39 valid results: a win rate with its interval, and the low-sample label (under 100)
    expect(within(summary).getByTestId('summary-win-rate')).toHaveTextContent(/54% \(95% CI/);
    expect(within(summary).getByTestId('summary-win-rate')).toHaveTextContent('Low sample');
    expect(within(summary).getByTestId('summary-net-r')).toHaveTextContent('+6.');
    expect(rowIds().slice(0, 5)).toEqual([43, 42, 41, 40, 39]);
  });

  it('shows the columns of the spec: levels, result, net R, duration, cause with its category, evidence', async () => {
    await open();
    for (const title of [
      'Time',
      '#',
      'Strategy',
      'Side',
      'Grade',
      'Entry',
      'Stop',
      'TP1',
      'TP2',
      'Result',
      'Net R',
      'Duration',
      'Cause',
      'Evidence',
    ]) {
      expect(within(screen.getByTestId('history-table')).getByTitle(title)).toBeInTheDocument();
    }
    const loss = within(screen.getByTestId('history-row-40'));
    expect(loss.getByText('Loss')).toBeInTheDocument();
    expect(loss.getByText('-1.04R')).toBeInTheDocument();
    expect(loss.getByText('15 min')).toBeInTheDocument();
    expect(loss.getByText('No follow-through')).toBeInTheDocument();
    expect(loss.getByText('Setup failure')).toBeInTheDocument();
    expect(loss.getByText('4021.600')).toBeInTheDocument();
    // below 30 resolved trades the evidence is a count, never a percentage
    expect(loss.getByText(/^n=\d+ \(insufficient\)$/)).toBeInTheDocument();
    // a clean win has no cause; an open signal has no result yet
    expect(within(screen.getByTestId('history-row-41')).getByText('Win')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-row-43')).getByText('Open')).toBeInTheDocument();
  });

  it('links each number to its detail page', async () => {
    await open();
    const link = within(screen.getByTestId('history-row-40')).getByRole('link', { name: 'S-0040' });
    expect(link.getAttribute('href')).toMatch(/^\/signals\/[0-9a-f-]{36}$/);
  });

  it('opens the detail page when a row is clicked', async () => {
    const user = userEvent.setup();
    const { router } = await open();
    await user.click(within(screen.getByTestId('history-row-40')).getByText('Loss'));
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/signals\/[0-9a-f-]{36}$/);
    });
  });

  it('loads 20 signals at a time and the next page on "Load more", until all 43 are there', async () => {
    const user = userEvent.setup();
    await open();
    expect(rowIds()).toHaveLength(20);
    expect(screen.getByTestId('history-count')).toHaveTextContent('Showing 20 of 43 signals');
    await user.click(screen.getByTestId('history-load-more'));
    await waitFor(() => {
      expect(rowIds()).toHaveLength(40);
    });
    await user.click(screen.getByTestId('history-load-more'));
    await waitFor(() => {
      expect(rowIds()).toHaveLength(43);
    });
    expect(screen.getByTestId('history-count')).toHaveTextContent('Showing 43 of 43 signals');
    expect(screen.queryByTestId('history-load-more')).toBeNull();
    expect(new Set(rowIds()).size).toBe(43);
  });

  it('narrows the list by result, and the summary follows the filter and the address bar', async () => {
    const user = userEvent.setup();
    const { router } = await open();
    await choose(user, 'Result', 'Loss');
    await waitFor(() => {
      expect(screen.getByTestId('summary-signals')).toHaveTextContent('15');
    });
    expect(rowIds().length).toBe(15);
    expect(rowIds()).not.toContain(41);
    expect(router.state.location.search).toBe('?result=LOSS');
    // 15 valid results: the counts only, no percentage
    expect(screen.getByTestId('summary-win-rate')).toHaveTextContent(
      'Insufficient evidence (15 results)',
    );
    expect(screen.getByTestId('summary-note')).toHaveTextContent('For the current filters.');
  });

  it('narrows by strategy and by failure cause, and combines filters', async () => {
    const user = userEvent.setup();
    await open();
    await choose(user, 'Failure cause', 'News shock');
    await waitFor(() => {
      expect(rowIds().sort((a, b) => a - b)).toEqual([10, 34]);
    });
    await choose(user, 'Strategy', 'Trend Pullback');
    await waitFor(() => {
      expect(rowIds()).toEqual([10]);
    });
    // clearing the filters brings the whole list back
    await user.click(screen.getByTestId('history-filter-reset'));
    await waitFor(() => {
      expect(rowIds().length).toBe(20);
    });
    expect(screen.getByTestId('history-filter-reset')).toBeDisabled();
  });

  it('filters by a date range of whole days in the display time zone', async () => {
    const { client } = await open();
    const all = await client.getSignals({ limit: 200 });
    const day = (iso: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
    const target = all.items.find((row) => row.seq === 20);
    if (!target) throw new Error('no signal 20');
    const date = day(target.generatedAt);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: date } });
    await waitFor(() => {
      expect(screen.getByTestId('summary-signals')).toHaveTextContent('1');
    });
    expect(rowIds()).toEqual([20]);
  });

  it('keeps both dates when two fields change before the page has rendered again (no lost update)', async () => {
    const { router } = await open('/signals?result=WIN&strategy=trend_pullback&side=SELL', 20);
    // two changes in one batch: the second must start from the first, not from the old address
    act(() => {
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-22' } });
    });
    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('from')).toBe('2026-10-20');
    expect(search.get('to')).toBe('2026-10-22');
    expect(search.get('result')).toBe('WIN');
    expect(search.get('strategy')).toBe('trend_pullback');
  });

  it('says so, and applies neither date, when the end date is before the start date', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    expect(await screen.findByText('The end date is before the start date')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('summary-signals')).toHaveTextContent('43');
    });
  });

  it('sorts by a column, in the API and across pages, and reverses on the second click', async () => {
    const user = userEvent.setup();
    const { router } = await open();
    const header = within(screen.getByTestId('history-table'));
    // the first click on a column sorts it from the highest value, the next click reverses it
    await user.click(header.getByTitle('Net R'));
    await waitFor(() => {
      expect(rowIds()[0]).toBe(20); // the best win, +1.49R, although it is on page 2 by time
    });
    expect(router.state.location.search).toBe('?sort=realizedRNet&order=desc');
    await user.click(header.getByTitle('Net R'));
    await waitFor(() => {
      expect(rowIds()[0]).toBe(34); // the biggest loss, -1.15R
    });
    expect(router.state.location.search).toBe('?sort=realizedRNet&order=asc');
  });

  it('keeps open and cancelled signals last when sorting by net R', async () => {
    const user = userEvent.setup();
    await open('/signals?sort=realizedRNet&order=asc&strategy=sweep_reversal');
    await screen.findByTestId('history-row-34');
    await user.click(screen.getByTestId('history-filter-reset'));
    await waitFor(() => {
      expect(screen.getByTestId('summary-signals')).toHaveTextContent('43');
    });
    const ids = rowIds();
    expect(ids[0]).toBe(34);
    // the open signals have no net R: they are not at the top of an ascending list
    expect(ids).not.toContain(43);
  });

  it('starts from the filters and the sort in the address bar, and ignores values that are not valid', async () => {
    await open('/signals?result=LOSS&sort=durationS&order=asc&regime=NOPE&from=2026-13-45', 34);
    await waitFor(() => {
      expect(rowIds().length).toBe(15);
    });
    expect(screen.getByRole('combobox', { name: 'Result' })).toHaveValue('Loss');
    expect(screen.getByRole('combobox', { name: 'Regime' })).toHaveValue('');
    // shortest first: signal 34 lasted 14 minutes
    expect(rowIds()[0]).toBe(34);
  });

  it('shows a message and no percentage when nothing matches', async () => {
    const user = userEvent.setup();
    await open();
    await choose(user, 'Strategy', 'Chart Pattern Breakout');
    expect(await screen.findByText('No signals match these filters.')).toBeInTheDocument();
    expect(screen.getByTestId('summary-signals')).toHaveTextContent('0');
    expect(screen.getByTestId('summary-win-rate')).toHaveTextContent(
      'Insufficient evidence (0 results)',
    );
    expect(screen.getByTestId('history-count')).toHaveTextContent('Showing 0 of 0 signals');
  });

  it('shows no win rate for a strategy with fewer than 30 valid results, only the counts', async () => {
    const user = userEvent.setup();
    await open();
    await choose(user, 'Strategy', 'Squeeze Breakout and Retest');
    await waitFor(() => {
      expect(screen.getByTestId('summary-valid')).toHaveTextContent('4');
    });
    expect(screen.getByTestId('history-summary').textContent).not.toMatch(/%/);
  });
});
