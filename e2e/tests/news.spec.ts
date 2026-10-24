import { expect, test, type Locator, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Scenario E11 on the simulated news (05_UI_Spec section 9.4): the three news states look
// different, the calendar, the headlines and the market moves are what the API sent, a feed that
// is down shows a banner and not an empty list, a move shows headlines as possible causes or says
// that none was found, and no text claims that a headline caused a move. Every check reads the
// DOM; no image is taken.

const CAUSAL = /\b(caused|because of|due to the|led to|triggered|drove|driven by|resulted from)\b/i;

async function openNews(
  page: Page,
  options: { scenario?: string; query?: string; tab?: 'Headlines' | 'Market moves' } = {},
) {
  if (options.scenario === undefined) {
    await logIn(page);
    await page.goto(`/news${options.query ?? ''}`);
  } else {
    // a reload does not keep the preview state, so the page is reached through the navigation
    await logIn(page, { scenario: options.scenario });
    await page.getByRole('link', { name: 'News', exact: true }).click();
    if (options.tab !== undefined) await page.getByRole('tab', { name: options.tab }).click();
  }
  await expect(page.getByRole('heading', { name: 'News', level: 1 })).toBeVisible();
  await expect(page.getByTestId('news-state-chip')).toBeVisible();
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const headlineRows = (page: Page) => page.getByTestId(/^headline-[0-9a-f-]{36}$/);
const eventRows = (page: Page, table: 'news-upcoming' | 'news-past') =>
  page.getByTestId(table).getByTestId(/^news-event-/);
const cells = (row: Locator) => row.locator('th,td').allTextContents();

test.describe('E11 news: the three states', () => {
  const states = [
    {
      scenario: 'two-open',
      chip: 'CLEAR',
      says: ['No high-impact event is inside its news window.', 'Next: US CPI (simulated)'],
      never: ['unavailable', 'A high-impact event is close'],
    },
    {
      scenario: 'wait',
      chip: 'IN WINDOW',
      says: [
        'A high-impact event is close: US CPI (simulated)',
        'The news window runs from',
        'Signals are still sent, with a NEWS WINDOW warning.',
      ],
      never: ['unavailable', 'No high-impact event'],
    },
    {
      scenario: 'news-unknown',
      chip: 'UNKNOWN',
      says: [
        'The calendar feed is unavailable',
        'This is not the same as no event.',
        'Signals carry a NEWS UNKNOWN warning.',
        'The last successful calendar fetch was 3 h 12 min ago.',
      ],
      never: ['No high-impact event', 'Next:'],
    },
  ] as const;

  for (const { scenario, chip, says, never } of states) {
    test(`${chip}: renders its own chip and its own words`, async ({ page }) => {
      await openNews(page, { scenario });
      await expect(page.getByTestId('news-state-chip')).toHaveText(chip);
      const text = page.getByTestId('news-state-text');
      for (const phrase of says) await expect(text).toContainText(phrase);
      for (const phrase of never) await expect(text).not.toContainText(phrase);
      await expect(page.getByTestId('news-state')).toContainText(
        'The news state only warns. It blocks a signal only if you set the news-window flag to block',
      );
    });
  }
});

test.describe('E11 news: the calendar', () => {
  test('opens from the navigation on the calendar, with the three tabs', async ({ page }) => {
    await logIn(page);
    await page.getByRole('link', { name: 'News', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'News', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText(['Calendar', 'Headlines', 'Market moves']);
    await expect(page.getByRole('tab', { name: 'Calendar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('news-upcoming')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('lists the upcoming events with a countdown, and the released ones with the surprise and the move of gold', async ({
    page,
  }) => {
    await openNews(page);
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(8);
    await expect(eventRows(page, 'news-past')).toHaveCount(10);
    await expect(page.getByTestId('news-upcoming').getByRole('columnheader')).toHaveText([
      'Time',
      'In',
      'Event',
      'Importance',
      'Forecast',
      'Previous',
    ]);

    const cpi = await cells(page.getByTestId('news-event-00000000-0000-4000-8000-00000000e001'));
    expect(cpi[1]).toMatch(/^(3 h 5\d min|4 h)$/);
    expect(cpi.slice(2)).toEqual(['US CPI (simulated)', 'High', '0.3%', '0.4%']);
    // an event without numbers shows dashes, never zeros
    const minutes = await cells(
      page.getByTestId('news-event-00000000-0000-4000-8000-00000000e004'),
    );
    expect(minutes.slice(2)).toEqual([
      'FOMC meeting minutes (simulated)',
      'High',
      '\u2013',
      '\u2013',
    ]);

    const payrolls = await cells(
      page.getByTestId('news-event-00000000-0000-4000-8000-00000000e01b'),
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
    // an event that has happened but whose value has not arrived says so, and is not zero
    const waiting = await cells(
      page.getByTestId('news-event-00000000-0000-4000-8000-00000000e014'),
    );
    expect(waiting[3]).toBe('Not delivered yet');
    expect(waiting[7]).toBe('\u2013Surprise not measured');
    await expect(page.getByTestId('calendar-fetch-age')).toContainText(
      'Calendar last fetched 45 s ago.',
    );
    await expect(page.getByTestId('calendar-fetch-age')).not.toContainText(
      'Calendar feed not answering',
    );
  });

  test('with the calendar feed down it warns instead of showing an empty list, and keeps the stored past', async ({
    page,
  }) => {
    await openNews(page, { scenario: 'news-unknown' });
    const upcoming = page.getByTestId('news-upcoming');
    await expect(upcoming).toContainText('Upcoming events are not known');
    await expect(upcoming).toContainText(
      'An empty list here would not mean that nothing is scheduled.',
    );
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(0);
    await expect(eventRows(page, 'news-past')).toHaveCount(10);
    await expect(page.getByTestId('calendar-fetch-age')).toContainText(
      'Calendar last fetched 3 h 12 min ago.',
    );
    await expect(page.getByTestId('calendar-fetch-age')).toContainText(
      'Calendar feed not answering',
    );
  });

  test('filters by importance, keeps it in the address, and a reload keeps it', async ({
    page,
  }) => {
    await openNews(page);
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(8);
    await choose(page, 'Importance', 'High');
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(3);
    await expect(eventRows(page, 'news-past')).toHaveCount(4);
    expect(new URL(page.url()).search).toBe('?importance=high');
    await page.reload();
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(3);
    await expect(page.getByRole('combobox', { name: 'Importance' })).toHaveValue('High');
    await choose(page, 'Importance', 'All');
    await expect(eventRows(page, 'news-upcoming')).toHaveCount(8);
    expect(new URL(page.url()).search).toBe('');
  });
});

test.describe('E11 news: the headlines', () => {
  test('lists the headlines newest first with impact, topics, outlets, delay and the move of gold', async ({
    page,
  }) => {
    await openNews(page);
    await page.getByRole('tab', { name: 'Headlines' }).click();
    expect(new URL(page.url()).search).toBe('?tab=headlines');
    await expect(headlineRows(page)).toHaveCount(14);
    await expect(page.getByTestId('headlines-count')).toHaveText('Showing 14 headlines');
    await expect(page.getByTestId('headline-feed-banner')).toHaveCount(0);

    const first = headlineRows(page).first();
    await expect(first).toHaveAttribute('data-testid', /e00b$/);
    await expect(first).toContainText('Simulated headline');
    await expect(first).toContainText('Medium impact');
    await expect(first).toContainText('Fed and interest rates');
    await expect(first).toContainText('Simulated feed A');
    await expect(first).toContainText('seen 2 min after publishing');
    await expect(first).toContainText('Gold since publication: +1.20 USD (+0.3 ATR)');
    const link = first.getByRole('link');
    await expect(link).toHaveAttribute('href', 'https://example.com/simulated-1');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // what is not known is said, not guessed
    const bank = headlineRows(page).filter({ hasText: 'adds to its gold reserves' });
    await expect(bank).toContainText('detection delay not known');
    await expect(bank).toContainText('Gold since publication: not measured');
  });

  test('filters by impact and topic, keeps them in the address, and clears them', async ({
    page,
  }) => {
    await openNews(page, { query: '?tab=headlines' });
    await expect(headlineRows(page)).toHaveCount(14);
    await choose(page, 'Minimum impact', 'High and above');
    await expect(headlineRows(page)).toHaveCount(4);
    await choose(page, 'Topic', 'Risk-off moves');
    await expect(headlineRows(page)).toHaveCount(2);
    await expect(page.getByTestId('headlines-count')).toHaveText('Showing 2 headlines');
    expect(new URL(page.url()).search).toBe('?tab=headlines&impact=HIGH&topic=RISK_OFF');
    // a reload keeps the filters
    await page.reload();
    await expect(headlineRows(page)).toHaveCount(2);
    await expect(page.getByRole('combobox', { name: 'Topic' })).toHaveValue('Risk-off moves');
    await choose(page, 'Minimum impact', 'Any impact');
    await choose(page, 'Topic', 'All topics');
    await expect(headlineRows(page)).toHaveCount(14);
    expect(new URL(page.url()).search).toBe('?tab=headlines');
  });

  test('says so when no headline matches, and that is not the banner', async ({ page }) => {
    await openNews(page, { query: '?tab=headlines&impact=HIGH&topic=GOLD_DIRECT' });
    await expect(page.getByTestId('news-headlines')).toContainText(
      'No headline matches these filters.',
    );
    await expect(page.getByTestId('headline-feed-banner')).toHaveCount(0);
  });

  test('while the feeds are down: the banner names each feed and its error, and keeps the stored headlines', async ({
    page,
  }) => {
    await openNews(page, { scenario: 'news-unknown', tab: 'Headlines' });
    const banner = page.getByTestId('headline-feed-banner');
    await expect(banner).toContainText('Headline feed unavailable');
    await expect(banner).toContainText('None of the 3 headline feeds is working');
    await expect(banner).toContainText('A short or empty list is not the same as no news.');
    for (const name of ['Simulated feed A', 'Simulated feed B', 'Simulated feed C']) {
      await expect(banner).toContainText(`${name}: Timed out after 20 s`);
    }
    await expect(headlineRows(page)).toHaveCount(11);
  });

  test('while the feeds are down, an empty result is not worded as "no news"', async ({ page }) => {
    await openNews(page, { scenario: 'news-unknown', tab: 'Headlines' });
    await choose(page, 'Minimum impact', 'High and above');
    await choose(page, 'Topic', 'Gold directly');
    const list = page.getByTestId('news-headlines');
    await expect(list).toContainText(
      'No headline to show. The feeds are unavailable, which is not the same as no news.',
    );
    await expect(list).not.toContainText('No headline matches');
  });

  test('the dashboard card says the same, in its own words', async ({ page }) => {
    await logIn(page, { scenario: 'news-unknown' });
    await expect(page.getByTestId('news-headlines-down')).toHaveText(
      'Headline feed unavailable. This is not the same as no news.',
    );
  });
});

test.describe('E11 news: the market moves', () => {
  test('lists the moves newest first with the size, the window, the ATR and the spread', async ({
    page,
  }) => {
    await openNews(page, { query: '?tab=moves' });
    const cards = page.getByTestId(/^move-\d+$/);
    await expect(cards).toHaveCount(5);
    expect(
      await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))),
    ).toEqual(['move-5', 'move-4', 'move-3', 'move-2', 'move-1']);
    const newest = page.getByTestId('move-5');
    await expect(newest).toContainText('Spike up');
    await expect(newest).toContainText('+9.80 USD in 5 min');
    await expect(newest).toContainText('2.8 \u00d7 ATR(5m) \u00b7 spread 0.350');
    await expect(page.getByTestId('move-3')).toContainText('+4.10 USD in 1 min');
    await expect(page.getByTestId('move-3')).toContainText('3.2 \u00d7 ATR(1m)');
    await expect(page.getByTestId('move-1')).toContainText('spread not recorded');
  });

  test('words the headlines as possible causes that are not confirmed, and says so when none was found', async ({
    page,
  }) => {
    await openNews(page, { query: '?tab=moves' });
    const card = page.getByTestId('move-5');
    await expect(
      card.getByRole('heading', { name: 'Possible causes, not confirmed', level: 4 }),
    ).toBeVisible();
    await expect(card).toContainText('Headlines of the 30 minutes before the move, by impact.');
    const items = card.getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('High impact');
    await expect(items.nth(0)).toContainText('missile strike reported near a shipping lane');
    await expect(items.nth(0)).toContainText('(16 min before the move)');
    await expect(items.nth(2)).toContainText('Unclassified, timing only');
    for (const link of await card.getByRole('link').all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }

    const none = page.getByTestId('move-3-none');
    await expect(none).toContainText('No matching headline found in the free feeds.');
    await expect(none).toContainText(
      'The move may be technical, flow-driven, or the news may not be in these feeds yet.',
    );
    await expect(page.getByTestId('move-3').getByRole('list')).toHaveCount(0);
    await expect(page.getByTestId('news-moves')).toContainText('This is context, not a signal.');
  });
});

test.describe('E11 news: no text says that a headline caused a move', () => {
  for (const scenario of ['two-open', 'wait', 'news-unknown'] as const) {
    test(`on every tab, in the ${scenario} state`, async ({ page }) => {
      await openNews(page, { scenario });
      for (const [tab, ready] of [
        ['Calendar', 'news-past'],
        ['Headlines', 'news-headlines'],
        ['Market moves', 'news-moves'],
      ] as const) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByTestId(ready)).toBeVisible();
        const text = await page.getByTestId('page-news').innerText();
        expect(text, `${tab} in ${scenario}`).not.toMatch(CAUSAL);
      }
    });
  }
});
