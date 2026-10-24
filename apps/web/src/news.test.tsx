import { List } from '@mantine/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  HeadlinesResponse,
  MarketMove,
  NewsEventsResponse,
  NewsStateResponse,
} from '@vmgs/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { HeadlineFeedBanner, HeadlineRow } from './news/HeadlinesTab';
import { MoveCard, NO_MATCH_TEXT } from './news/MovesTab';
import { CalendarView } from './news/CalendarTab';
import { NEWS_STATE_CHIP, NewsStateCard } from './news/NewsStateCard';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
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
  await screen.findByTestId('news-state');
  return { client, mock, router, user: userEvent.setup() };
}

const cellsOf = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent);

/** The element at a position, or a failure that says so (the lint rules do not allow a cast). */
function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`nothing at position ${String(index)}`);
  return found;
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option, hidden: true }));
}

/** What no text of the News screen may say: that a headline made gold move. */
const CAUSAL = /\b(caused|because of|due to the|led to|triggered|drove|driven by|resulted from)\b/i;

describe('the news screen (scenario E11)', () => {
  it('has a heading, the news-risk state and the three tabs, and the calendar is the first', async () => {
    await open('/news');
    expect(screen.getByRole('heading', { name: 'News', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Calendar',
      'Headlines',
      'Market moves',
    ]);
    expect(screen.getByRole('tab', { name: 'Calendar' })).toHaveAttribute('aria-selected', 'true');
    expect(document.title).toContain('News');
    expect(await screen.findByTestId('news-upcoming')).toBeInTheDocument();
  });

  it('opens the tab and the filters of the address, and the tab switch changes the address', async () => {
    const { router, user } = await open('/news?tab=moves');
    expect(await screen.findByTestId('news-moves')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Market moves' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: 'Headlines' }));
    expect(await screen.findByTestId('news-headlines')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=headlines');
    await user.click(screen.getByRole('tab', { name: 'Calendar' }));
    expect(await screen.findByTestId('news-upcoming')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });

  it('opens on the calendar for a tab it does not know', async () => {
    await open('/news?tab=weather');
    expect(screen.getByRole('tab', { name: 'Calendar' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says that it is context and never that a headline caused a move, on every tab', async () => {
    const { user } = await open('/news');
    await screen.findByTestId('news-upcoming');
    for (const tab of ['Calendar', 'Headlines', 'Market moves']) {
      await user.click(screen.getByRole('tab', { name: tab }));
      await screen.findByTestId(
        tab === 'Calendar'
          ? 'news-upcoming'
          : tab === 'Headlines'
            ? 'news-headlines'
            : 'news-moves',
      );
      expect(screen.getByTestId('page-news').textContent, tab).not.toMatch(CAUSAL);
    }
    expect(screen.getByTestId('page-news')).toHaveTextContent(
      'it never creates a signal, and a headline is never shown as the reason for a move',
    );
  });
});

describe('the news-risk state: three states that look different', () => {
  it('CLEAR: no event inside its window, the next one with its countdown and when its window starts', async () => {
    await open('/news', { scenario: 'two-open' });
    const card = screen.getByTestId('news-state');
    expect(within(card).getByTestId('news-state-chip')).toHaveTextContent('CLEAR');
    const text = within(card).getByTestId('news-state-text');
    expect(text).toHaveTextContent('No high-impact event is inside its news window.');
    expect(text).toHaveTextContent('Next: US CPI (simulated)');
    expect(text).toHaveTextContent(/\(in (3 h 5\d min|4 h)\)/);
    expect(text).toHaveTextContent('Its news window starts at');
    expect(text).not.toHaveTextContent('unavailable');
  });

  it('IN WINDOW: names the event and the window, and says that signals only get a warning', async () => {
    await open('/news', { scenario: 'wait' });
    const card = screen.getByTestId('news-state');
    expect(within(card).getByTestId('news-state-chip')).toHaveTextContent('IN WINDOW');
    const text = within(card).getByTestId('news-state-text');
    expect(text).toHaveTextContent('A high-impact event is close: US CPI (simulated)');
    expect(text).toHaveTextContent('The news window runs from');
    await waitFor(() => {
      expect(text).toHaveTextContent('Signals are still sent, with a NEWS WINDOW warning.');
    });
  });

  it('IN WINDOW: says that signals are blocked when the owner set the flag to block', async () => {
    const mock = createMockClient({ storage: memoryStorage(), latencyMs: 0, scenario: 'wait' });
    await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
    await mock.updateSettings({ advisoryGates: { newsWindow: 'block' } });
    renderApp({ client: mock, route: '/news' });
    const text = await screen.findByTestId('news-state-text');
    await waitFor(() => {
      expect(text).toHaveTextContent(
        'You set this flag to block: no signal is sent while the window lasts.',
      );
    });
    expect(text).not.toHaveTextContent('Signals are still sent');
  });

  it('UNKNOWN: says that the calendar feed is unavailable, which is not the same as no event, and how old the last fetch is', async () => {
    await open('/news', { scenario: 'news-unknown' });
    const card = screen.getByTestId('news-state');
    expect(within(card).getByTestId('news-state-chip')).toHaveTextContent('UNKNOWN');
    const text = within(card).getByTestId('news-state-text');
    expect(text).toHaveTextContent('The calendar feed is unavailable');
    expect(text).toHaveTextContent('This is not the same as no event.');
    expect(text).toHaveTextContent('Signals carry a NEWS UNKNOWN warning.');
    expect(text).toHaveTextContent('The last successful calendar fetch was 3 h 12 min ago.');
    expect(text).not.toHaveTextContent('Next:');
    expect(text).not.toHaveTextContent('No high-impact event');
  });

  it('has different words and a different chip text in each of the three states', () => {
    expect(Object.values(NEWS_STATE_CHIP).map((chip) => chip.text)).toEqual([
      'CLEAR',
      'IN WINDOW',
      'UNKNOWN',
    ]);
    // the chips of the three states differ, and the two that warn are never worded alike
    expect(new Set(Object.values(NEWS_STATE_CHIP).map((chip) => chip.text)).size).toBe(3);
  });

  it('says the news state only warns, and where the flag is', async () => {
    await open('/news');
    expect(screen.getByTestId('news-state')).toHaveTextContent(
      'The news state only warns. It blocks a signal only if you set the news-window flag to block (System, Alerts).',
    );
  });

  it('shows what it can when there is no next event, in the clear state', () => {
    const state: NewsStateResponse = { state: 'CLEAR', next: null, last: null, sourceAgeS: 45 };
    render(
      <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
        <NewsStateCard state={state} nowMs={Date.now()} gateMode="warn" />
      </AppProviders>,
    );
    expect(screen.getByTestId('news-state-text')).toHaveTextContent(
      'No high-impact event is scheduled.',
    );
  });

  it('says an in-window state without a window when the data has no event to name', () => {
    const state: NewsStateResponse = { state: 'IN_WINDOW', next: null, last: null, sourceAgeS: 45 };
    render(
      <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
        <NewsStateCard state={state} nowMs={Date.now()} gateMode={undefined} />
      </AppProviders>,
    );
    const text = screen.getByTestId('news-state-text');
    expect(text).toHaveTextContent('A high-impact event is close.');
    // the mode of the flag is not known yet: nothing is said about it
    expect(text).not.toHaveTextContent('Signals are still sent');
    expect(text).not.toHaveTextContent('blocked');
  });

  it('says that the calendar was never fetched when it never was', () => {
    const state: NewsStateResponse = { state: 'UNKNOWN', next: null, last: null, sourceAgeS: null };
    render(
      <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
        <NewsStateCard state={state} nowMs={Date.now()} gateMode="warn" />
      </AppProviders>,
    );
    expect(screen.getByTestId('news-state-text')).toHaveTextContent(
      'The calendar has never been fetched.',
    );
  });
});

describe('the calendar', () => {
  it('lists the upcoming events with a countdown, importance, forecast and previous, as the API sent them', async () => {
    const { client } = await open('/news');
    const upcoming = await screen.findByTestId('news-upcoming');
    const { items } = await client.getNewsEvents({});
    const toCome = items.filter((event) => Date.parse(event.scheduledAt) > Date.now());
    expect(within(upcoming).getAllByTestId(/^news-event-/)).toHaveLength(8);
    expect(toCome).toHaveLength(8);
    const cpi = cellsOf(
      within(upcoming).getByTestId('news-event-00000000-0000-4000-8000-00000000e001'),
    );
    expect(cpi[2]).toBe('US CPI (simulated)');
    expect(cpi[1]).toMatch(/^(3 h 5\d min|4 h)$/);
    expect(cpi.slice(3)).toEqual(['High', '0.3%', '0.4%']);
    // an event without numbers shows dashes, not zeros
    const minutes = cellsOf(
      within(upcoming).getByTestId('news-event-00000000-0000-4000-8000-00000000e004'),
    );
    expect(minutes.slice(2)).toEqual([
      'FOMC meeting minutes (simulated)',
      'High',
      '\u2013',
      '\u2013',
    ]);
    expect(
      within(upcoming)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'In', 'Event', 'Importance', 'Forecast', 'Previous']);
  });

  it('lists the released events, newest first, with the surprise and the move of gold', async () => {
    await open('/news');
    const past = await screen.findByTestId('news-past');
    const rows = within(past).getAllByTestId(/^news-event-/);
    expect(rows).toHaveLength(10);
    expect(
      within(past)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Time',
      'Event',
      'Importance',
      'Actual',
      'Forecast',
      'Previous',
      'Revised previous',
      'Surprise',
      'Gold in the 5 min after',
    ]);
    expect(cellsOf(at(rows, 0))[1]).toBe('US durable goods orders m/m (simulated)');
    const payrolls = cellsOf(
      within(past).getByTestId('news-event-00000000-0000-4000-8000-00000000e01b'),
    );
    expect(payrolls.slice(1)).toEqual([
      'US non-farm payrolls (simulated)',
      'High',
      '212K',
      '185K',
      '142K',
      '156K',
      '+1.8\u03c3',
      '-7.30 USD (-1.6 ATR)',
    ]);
    const times = rows.map((row) => row.querySelector('time')?.getAttribute('datetime') ?? '');
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('says that the value of an event that has happened has not been delivered yet, and not zero', async () => {
    await open('/news');
    const waiting = cellsOf(
      await screen.findByTestId('news-event-00000000-0000-4000-8000-00000000e014'),
    );
    expect(waiting[3]).toBe('Not delivered yet');
    expect(waiting[4]).toBe('0.5%');
    // no surprise and no move are measured for it
    expect(waiting[7]).toBe('\u2013Surprise not measured');
    expect(waiting[8]).toBe('\u2013Move of gold not measured');
  });

  it('shows a dash and the reason for a released event whose surprise could not be measured', async () => {
    await open('/news');
    const gdp = cellsOf(
      await screen.findByTestId('news-event-00000000-0000-4000-8000-00000000e01d'),
    );
    expect(gdp.slice(3, 5)).toEqual(['3.1%', '2.8%']);
    expect(gdp[7]).toBe('\u2013Surprise not measured');
    expect(gdp[8]).toBe('\u2013Move of gold not measured');
  });

  it('says when the calendar was last fetched, with no warning while it answers', async () => {
    await open('/news');
    const age = await screen.findByTestId('calendar-fetch-age');
    expect(age).toHaveTextContent('Calendar last fetched 45 s ago.');
    expect(age).not.toHaveTextContent('Calendar feed not answering');
  });

  it('with the calendar feed down: a warning instead of the upcoming list, the stored past, and the age of the last fetch', async () => {
    await open('/news', { scenario: 'news-unknown' });
    const upcoming = await screen.findByTestId('news-upcoming');
    expect(upcoming).toHaveTextContent('Upcoming events are not known');
    expect(upcoming).toHaveTextContent(
      'An empty list here would not mean that nothing is scheduled.',
    );
    expect(within(upcoming).queryAllByTestId(/^news-event-/)).toHaveLength(0);
    expect(
      within(await screen.findByTestId('news-past')).getAllByTestId(/^news-event-/),
    ).toHaveLength(10);
    const age = screen.getByTestId('calendar-fetch-age');
    expect(age).toHaveTextContent('Calendar last fetched 3 h 12 min ago.');
    expect(age).toHaveTextContent('Calendar feed not answering');
  });

  it('filters by importance, keeps it in the address and clears it with "All"', async () => {
    const { router, user } = await open('/news');
    await screen.findByTestId('news-upcoming');
    await choose(user, 'Importance', 'High');
    expect(router.state.location.search).toBe('?importance=high');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('news-upcoming')).getAllByTestId(/^news-event-/),
      ).toHaveLength(3);
    });
    expect(within(screen.getByTestId('news-past')).getAllByTestId(/^news-event-/)).toHaveLength(4);
    await choose(user, 'Importance', 'All');
    expect(router.state.location.search).toBe('');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('news-upcoming')).getAllByTestId(/^news-event-/),
      ).toHaveLength(8);
    });
  });

  it('opens with the importance of the address, and says so when no event has it', async () => {
    await open('/news?importance=low');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('news-upcoming')).getAllByTestId(/^news-event-/),
      ).toHaveLength(1);
    });
    expect(screen.getByRole('combobox', { name: 'Importance' })).toHaveValue('Low');
  });

  describe('as a view', () => {
    const base = {
      id: '00000000-0000-4000-8000-00000000e0a1',
      name: 'Event',
      importance: 'high',
      currency: 'USD',
      unit: '%',
      actual: null,
      forecast: 0.3,
      previous: 0.4,
      revisedPrevious: null,
      surpriseSigma: null,
      goldMoveAfter: null,
    } as const;
    const NOW = Date.parse('2026-10-23T12:00:00Z');
    const show = (data: NewsEventsResponse, importance?: 'high') =>
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <CalendarView data={data} state="CLEAR" nowMs={NOW} importance={importance} />
        </AppProviders>,
      );

    it('puts an event at the moment of now in the past, and one a second later in the future', () => {
      show({
        items: [
          {
            ...base,
            id: '00000000-0000-4000-8000-00000000e0a1',
            name: 'At now',
            scheduledAt: new Date(NOW).toISOString(),
          },
          {
            ...base,
            id: '00000000-0000-4000-8000-00000000e0a2',
            name: 'A second later',
            scheduledAt: new Date(NOW + 1000).toISOString(),
          },
        ],
        sourceAgeS: 45,
      });
      expect(within(screen.getByTestId('news-past')).getByText('At now')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('news-upcoming')).getByText('A second later'),
      ).toBeInTheDocument();
      // each event is in one list only
      expect(within(screen.getByTestId('news-past')).queryByText('A second later')).toBeNull();
      expect(within(screen.getByTestId('news-upcoming')).queryByText('At now')).toBeNull();
    });

    it('says what is missing when a list is empty, with the importance that was asked for', () => {
      show({ items: [], sourceAgeS: 45 }, 'high');
      expect(screen.getByTestId('news-upcoming')).toHaveTextContent(
        'No event of high importance in the next week.',
      );
      expect(screen.getByTestId('news-past')).toHaveTextContent(
        'No event of high importance in the last two weeks.',
      );
    });

    it('warns when the calendar was fetched more than 10 minutes ago, not at exactly 10 minutes, and says when it never was', () => {
      const view = show({ items: [], sourceAgeS: 600 });
      expect(screen.getByTestId('calendar-fetch-age')).not.toHaveTextContent('not answering');
      view.unmount();
      const late = show({ items: [], sourceAgeS: 601 });
      expect(screen.getByTestId('calendar-fetch-age')).toHaveTextContent('not answering');
      late.unmount();
      show({ items: [], sourceAgeS: null });
      expect(screen.getByTestId('calendar-fetch-age')).toHaveTextContent(
        'The calendar has never been fetched.',
      );
      expect(screen.getByTestId('calendar-fetch-age')).toHaveTextContent('not answering');
    });
  });

  it('shows the error of the calendar with a retry button, and the rest of the page stays', async () => {
    let calls = 0;
    const { user } = await open('/news', {
      override: (mock) => ({
        getNewsEvents: (query) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('down')) : mock.getNewsEvents(query);
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the calendar');
    expect(screen.getByTestId('news-state')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('news-upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the headlines', () => {
  const rowsOf = () => within(screen.getByTestId('news-headlines')).getAllByTestId(/^headline-/);

  it('lists the 14 headlines of the preview, newest first, each marked as simulated, with a count', async () => {
    await open('/news?tab=headlines');
    await screen.findByTestId('news-headlines');
    expect(rowsOf()).toHaveLength(14);
    expect(rowsOf()[0]).toHaveAttribute(
      'data-testid',
      'headline-00000000-0000-4000-8000-00000000e00b',
    );
    for (const row of rowsOf()) expect(row.textContent).toContain('Simulated headline');
    expect(screen.getByTestId('headlines-count')).toHaveTextContent('Showing 14 headlines');
    expect(screen.queryByTestId('headlines-load-more')).not.toBeInTheDocument();
    expect(screen.queryByTestId('headline-feed-banner')).not.toBeInTheDocument();
  });

  it('shows impact, topics, the headline as an external link, the outlets, the time, the delay and the move of gold', async () => {
    await open('/news?tab=headlines');
    await screen.findByTestId('news-headlines');
    const first = at(rowsOf(), 0);
    expect(first).toHaveTextContent('Medium impact');
    expect(first).toHaveTextContent('Fed and interest rates');
    const link = within(first).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/simulated-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('(opens in a new tab)');
    expect(first).toHaveTextContent('Simulated feed A');
    expect(first.querySelector('time')).toHaveAttribute('datetime');
    expect(first).toHaveTextContent('seen 2 min after publishing');
    expect(first).toHaveTextContent('Gold since publication: +1.20 USD (+0.3 ATR)');
    // two outlets and two topics
    const dollar = at(rowsOf(), 1);
    expect(dollar).toHaveTextContent('Simulated feed A, Simulated feed B');
    expect(dollar).toHaveTextContent('Gold since publication: -0.40 USD (-0.1 ATR)');
    const risk = at(rowsOf(), 2);
    expect(risk).toHaveTextContent('Geopolitics and war');
    expect(risk).toHaveTextContent('Risk-off moves');
  });

  it('says that the delay and the move of gold are not known, when they are not', async () => {
    await open('/news?tab=headlines');
    await screen.findByTestId('news-headlines');
    const bank = rowsOf().find((row) => row.textContent.includes('adds to its gold reserves'));
    expect(bank).toHaveTextContent('detection delay not known');
    expect(bank).toHaveTextContent('Gold since publication: not measured');
  });

  it('filters by minimum impact and by topic, keeps them in the address and clears them', async () => {
    const { router, user } = await open('/news?tab=headlines');
    await screen.findByTestId('news-headlines');
    await choose(user, 'Minimum impact', 'High and above');
    expect(router.state.location.search).toBe('?tab=headlines&impact=HIGH');
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(4);
    });
    await choose(user, 'Topic', 'Risk-off moves');
    expect(router.state.location.search).toBe('?tab=headlines&impact=HIGH&topic=RISK_OFF');
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(2);
    });
    expect(screen.getByTestId('headlines-count')).toHaveTextContent('Showing 2 headlines');
    await choose(user, 'Minimum impact', 'Any impact');
    await choose(user, 'Topic', 'All topics');
    expect(router.state.location.search).toBe('?tab=headlines');
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(14);
    });
  });

  it('opens with the filters of the address, and says so when nothing matches', async () => {
    await open('/news?tab=headlines&impact=HIGH&topic=GOLD_DIRECT');
    expect(await screen.findByTestId('news-headlines')).toHaveTextContent(
      'No headline matches these filters.',
    );
    expect(screen.getByRole('combobox', { name: 'Minimum impact' })).toHaveValue('High and above');
    expect(screen.getByRole('combobox', { name: 'Topic' })).toHaveValue('Gold directly');
    expect(screen.getByTestId('headlines-count')).toHaveTextContent('Showing 0 headlines');
  });

  it('ignores a filter value that is not valid', async () => {
    await open('/news?tab=headlines&impact=URGENT&topic=SPORT');
    await screen.findByTestId('news-headlines');
    expect(rowsOf()).toHaveLength(14);
  });

  it('loads the next page with the cursor, without repeating a headline', async () => {
    const pages: (string | undefined)[] = [];
    const { user } = await open('/news?tab=headlines', {
      override: (mock) => ({
        getHeadlines: (query) => {
          pages.push(query.cursor);
          return mock.getHeadlines({ ...query, limit: 6 });
        },
      }),
    });
    await screen.findByTestId('news-headlines');
    expect(rowsOf()).toHaveLength(6);
    await user.click(screen.getByTestId('headlines-load-more'));
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(12);
    });
    await user.click(screen.getByTestId('headlines-load-more'));
    await waitFor(() => {
      expect(rowsOf()).toHaveLength(14);
    });
    expect(screen.queryByTestId('headlines-load-more')).not.toBeInTheDocument();
    expect(pages).toEqual([undefined, 'h6', 'h12']);
    const ids = rowsOf().map((row) => row.getAttribute('data-testid'));
    expect(new Set(ids).size).toBe(14);
  });

  describe('while the headline feeds are down', () => {
    it('shows the banner, names each feed and its error, and keeps the headlines that were stored before', async () => {
      await open('/news?tab=headlines', { scenario: 'news-unknown' });
      const banner = await screen.findByTestId('headline-feed-banner');
      expect(banner).toHaveTextContent('Headline feed unavailable');
      expect(banner).toHaveTextContent('None of the 3 headline feeds is working');
      expect(banner).toHaveTextContent('A short or empty list is not the same as no news.');
      for (const name of ['Simulated feed A', 'Simulated feed B', 'Simulated feed C']) {
        expect(banner).toHaveTextContent(`${name}: Timed out after 20 s`);
      }
      expect(rowsOf()).toHaveLength(11);
    });

    it('says that the feeds are unavailable instead of "no headlines", when there is nothing to show', async () => {
      await open('/news?tab=headlines&impact=HIGH&topic=GOLD_DIRECT', { scenario: 'news-unknown' });
      expect(await screen.findByTestId('headline-feed-banner')).toBeInTheDocument();
      const list = screen.getByTestId('news-headlines');
      expect(list).toHaveTextContent(
        'No headline to show. The feeds are unavailable, which is not the same as no news.',
      );
      expect(list).not.toHaveTextContent('No headline matches');
    });

    it('is the same banner on the dashboard card, in its own words', async () => {
      await open('/', { scenario: 'news-unknown' });
      const card = await screen.findByTestId('events-card');
      expect(await within(card).findByTestId('news-headlines-down')).toHaveTextContent(
        'Headline feed unavailable. This is not the same as no news.',
      );
      expect(within(card).queryByText('No headline in the last hours.')).not.toBeInTheDocument();
    });
  });

  describe('the banner as a view', () => {
    const NOW = Date.parse('2026-10-23T12:00:00Z');
    const source = (key: string, change = {}) => ({
      key,
      name: `Feed ${key}`,
      enabled: true,
      lastOkAt: new Date(NOW - 60_000).toISOString(),
      lastError: null,
      ...change,
    });
    const show = (sources: HeadlinesResponse['sources']) =>
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <HeadlineFeedBanner sources={sources} nowMs={NOW} />
        </AppProviders>,
      );

    it('is not there when every feed works', () => {
      const { container } = show([source('a'), source('b')]);
      expect(screen.queryByTestId('headline-feed-banner')).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent('unavailable');
    });

    it('says how many feeds are down when only some are', () => {
      show([source('a', { lastError: 'HTTP 503' }), source('b'), source('c')]);
      const banner = screen.getByTestId('headline-feed-banner');
      expect(banner).toHaveTextContent('Some headline feeds are unavailable');
      expect(banner).toHaveTextContent('1 of 3 headline feeds are not working.');
      expect(banner).toHaveTextContent('Feed a: HTTP 503');
      expect(banner).not.toHaveTextContent('Feed b');
    });

    it('treats a feed that has been silent for more than 10 minutes as down, one that has not as working', () => {
      const view = show([source('a', { lastOkAt: new Date(NOW - 600_000).toISOString() })]);
      expect(screen.queryByTestId('headline-feed-banner')).not.toBeInTheDocument();
      view.unmount();
      show([source('a', { lastOkAt: new Date(NOW - 601_000).toISOString() })]);
      expect(screen.getByTestId('headline-feed-banner')).toHaveTextContent(
        'No successful poll for 10 min',
      );
    });

    it('says that no feed is switched on when none is', () => {
      show([source('a', { enabled: false })]);
      expect(screen.getByTestId('headline-feed-banner')).toHaveTextContent(
        'No headline feed is switched on',
      );
    });
  });

  it('shows a headline without a publish time, and says so', () => {
    render(
      <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
        <List listStyleType="none">
          <HeadlineRow
            headline={{
              id: '00000000-0000-4000-8000-00000000e0b1',
              title: 'Simulated headline: no time',
              sources: [{ key: 'a', name: 'Feed A' }],
              publishedAt: null,
              firstSeenAt: '2026-10-23T12:00:00.000Z',
              delayS: null,
              topics: ['RISK_OFF'],
              impact: 'HIGH',
              url: 'https://example.com/x',
              goldMoveSincePublish: null,
            }}
          />
        </List>
      </AppProviders>,
    );
    const row = screen.getByTestId('headline-00000000-0000-4000-8000-00000000e0b1');
    expect(row).toHaveTextContent('publish time not known');
    expect(row).toHaveTextContent('detection delay not known');
    expect(row).toHaveTextContent('High impact');
  });
});

describe('the market moves', () => {
  const cardOf = (id: number) => screen.getByTestId(`move-${String(id)}`);

  it('lists the five moves of the preview, newest first, with their size, window, ATR and spread', async () => {
    await open('/news?tab=moves');
    const list = await screen.findByTestId('news-moves');
    expect(
      within(list)
        .getAllByTestId(/^move-\d+$/)
        .map((c) => c.getAttribute('data-testid')),
    ).toEqual(['move-5', 'move-4', 'move-3', 'move-2', 'move-1']);
    expect(cardOf(5)).toHaveTextContent('Spike up');
    expect(cardOf(5)).toHaveTextContent('+9.80 USD in 5 min');
    expect(cardOf(5)).toHaveTextContent('2.8 \u00d7 ATR(5m) \u00b7 spread 0.350');
    expect(cardOf(4)).toHaveTextContent('Spike down');
    expect(cardOf(4)).toHaveTextContent('-7.20 USD in 5 min');
    // a 1-minute move is measured against the 1-minute ATR
    expect(cardOf(3)).toHaveTextContent('+4.10 USD in 1 min');
    expect(cardOf(3)).toHaveTextContent('3.2 \u00d7 ATR(1m) \u00b7 spread 0.500');
    expect(cardOf(1)).toHaveTextContent('spread not recorded');
  });

  it('words the headlines as possible causes that are not confirmed, in order of impact, the unclassified ones last and labelled', async () => {
    await open('/news?tab=moves');
    await screen.findByTestId('news-moves');
    const card = cardOf(5);
    expect(
      within(card).getByRole('heading', { name: 'Possible causes, not confirmed', level: 4 }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent('Headlines of the 30 minutes before the move, by impact.');
    const items = within(card).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('High impact');
    expect(items[0]).toHaveTextContent('missile strike reported near a shipping lane');
    expect(items[0]).toHaveTextContent('Simulated feed A, Simulated feed B');
    expect(items[0]).toHaveTextContent('(16 min before the move)');
    expect(items[1]).toHaveTextContent('Medium impact');
    expect(items[2]).toHaveTextContent('Unclassified, timing only');
    expect(items[2]).toHaveTextContent('(3 min before the move)');
    for (const link of within(card).getAllByRole('link')) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('target', '_blank');
    }
  });

  it('says, for a move that no headline matches, that none was found, and does not guess', async () => {
    await open('/news?tab=moves');
    await screen.findByTestId('news-moves');
    const none = screen.getByTestId('move-3-none');
    expect(none).toHaveTextContent(NO_MATCH_TEXT);
    expect(none).toHaveTextContent(
      'The move may be technical, flow-driven, or the news may not be in these feeds yet.',
    );
    expect(within(cardOf(3)).queryByRole('list')).not.toBeInTheDocument();
    expect(within(cardOf(3)).queryByText('Possible causes, not confirmed')).not.toBeInTheDocument();
  });

  it('shows a move with only unclassified headlines as timing only, with no impact', async () => {
    await open('/news?tab=moves');
    await screen.findByTestId('news-moves');
    const items = within(cardOf(1)).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toHaveTextContent('Unclassified, timing only');
      expect(item).not.toHaveTextContent('impact');
    }
  });

  it('says that the moves are context, never that a headline moved the price', async () => {
    await open('/news?tab=moves');
    const list = await screen.findByTestId('news-moves');
    expect(list).toHaveTextContent('This is context, not a signal.');
    expect(list).toHaveTextContent('it is not known to have moved the price');
    expect(screen.getByTestId('page-news').textContent).not.toMatch(CAUSAL);
  });

  it('says so when there is no move at all', async () => {
    await open('/news?tab=moves', {
      override: () => ({ getMarketMoves: () => Promise.resolve({ items: [] }) }),
    });
    expect(await screen.findByTestId('news-moves')).toHaveTextContent(
      'No sudden move has been detected in the last 30 days.',
    );
  });

  it('shows the error of the moves with a retry button', async () => {
    const getMarketMoves = vi
      .fn<ApiClient['getMarketMoves']>()
      .mockRejectedValueOnce(new Error('down'));
    const { user } = await open('/news?tab=moves', {
      override: (mock) => {
        getMarketMoves.mockImplementation((query) => mock.getMarketMoves(query));
        return { getMarketMoves };
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the market moves');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('news-moves')).toBeInTheDocument();
  });

  describe('as a card', () => {
    const base: MarketMove = {
      id: 9,
      detectedAt: '2026-10-23T12:00:00.000Z',
      kind: 'SPIKE_DOWN',
      windowS: 90,
      moveUsd: 7.234,
      moveAtr: 2.04,
      spread: null,
      headlines: [],
    };

    it('writes a window that is not whole minutes in seconds, and the size with the sign of its direction', () => {
      render(
        <AppProviders client={createMockClient({ storage: memoryStorage(), latencyMs: 0 })}>
          <MoveCard move={base} />
        </AppProviders>,
      );
      expect(screen.getByTestId('move-9')).toHaveTextContent('-7.23 USD in 90 s');
      expect(screen.getByTestId('move-9')).toHaveTextContent('2.0 \u00d7 ATR(5m)');
    });
  });
});
