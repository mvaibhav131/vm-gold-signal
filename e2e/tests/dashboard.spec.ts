import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Scenarios E3 to E6 and E15 on the simulated market (05_UI_Spec section 9.4). Every check reads
// the DOM; no image is taken. The market state is chosen with `?scenario=` (the owner uses the
// "Preview state" picker for the same thing).

const card = (page: Page, seq: number): Locator => page.getByTestId(`signal-card-${String(seq)}`);

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('element has no box');
  return rect;
}

/** The chart library must never log an error: the dashboard is checked with a clean console. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test.describe('E4 WAIT reasons', () => {
  test('a known state shows the exact reason chips and no open signal', async ({ page }) => {
    await logIn(page, { scenario: 'wait' });
    const reasons = page.getByTestId('wait-reasons').getByRole('listitem');
    await expect(reasons).toHaveText([
      'Spread too high: 0.90 USD',
      'News window: CPI in 22 min',
      'Regime: range, no strategy accepts it',
    ]);
    await expect(page.getByTestId('open-count')).toHaveText('0');
    await expect(page.getByTestId('status-regime')).toHaveText('RANGE');
    await expect(page.getByTestId('news-state')).toHaveText('IN WINDOW');
  });
});

test.describe('E5 open signals', () => {
  test('two cards, the opposing one is marked, the open risk is the sum', async ({ page }) => {
    await logIn(page, { scenario: 'two-open' });
    await expect(page.getByTestId('signal-card-42')).toBeVisible();
    await expect(page.getByTestId('signal-card-43')).toBeVisible();
    await expect(page.getByTestId('open-count')).toHaveText('2');
    await expect(page.getByTestId('open-risk')).toHaveText('2.00R');
    await expect(card(page, 43).getByTestId('signal-warning-OPPOSES_OPEN')).toHaveText(
      'Opposes open signal S-0042',
    );
    await expect(card(page, 42).getByTestId('signal-warning-OPPOSES_OPEN')).toHaveCount(0);
    // Newest first.
    const ids = await page.getByTestId('open-signals').getByTestId('signal-id').allTextContents();
    expect(ids).toEqual(['S-0043', 'S-0042']);
  });

  test('each card shows the levels of the API with 3 decimals, and every evidence group', async ({
    page,
  }) => {
    await logIn(page, { scenario: 'two-open' });
    const buy = card(page, 42);
    await expect(buy.getByTestId('signal-side')).toHaveText('BUY');
    await expect(buy.getByTestId('signal-grade')).toHaveText('Strong 78');
    await expect(buy.getByTestId('signal-entry')).toHaveText('4017.370');
    await expect(buy.getByTestId('signal-stop')).toHaveText('4010.900');
    await expect(buy.getByTestId('signal-tp1')).toHaveText('4023.840');
    await expect(buy.getByTestId('signal-tp2')).toHaveText('4030.310');
    await expect(buy.getByTestId('signal-state')).toHaveText('ACTIVE');
    await expect(buy.getByTestId('signal-live-r')).toHaveText(/^[+-]?\d\.\d{2}R$/);

    const sell = card(page, 43);
    await expect(sell.getByTestId('signal-entry')).toHaveText('4017.000');
    await expect(sell.getByTestId('signal-stop')).toHaveText('4022.900');
    await expect(sell.getByTestId('signal-tp1')).toHaveText('4011.100');

    for (const key of [
      'trend',
      'structure',
      'trigger',
      'volatility',
      'execution',
      'sessionMacro',
      'reward',
    ]) {
      const row = buy.getByTestId(`signal-why-group-${key}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId(`signal-why-state-${key}`)).toHaveText(
        /^(STRONG|OK|WEAK|FAIL|NA)$/,
      );
    }
    await expect(buy.getByTestId('signal-why-group-trend')).toContainText('1h EMA: 20>50>200');
    const evidence = buy.getByTestId('signal-evidence');
    await expect(evidence.getByTestId('evidence-n')).toHaveText('n=64');
    await expect(evidence.getByTestId('evidence-ci')).toHaveText('46\u201369%');
  });

  test('the live R changes with the stream and the page is not reloaded', async ({ page }) => {
    await page.clock.install();
    await logIn(page, { scenario: 'two-open' });
    await page.evaluate(() => {
      (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
    });
    const live = card(page, 42).getByTestId('signal-live-r');
    const before = await live.textContent();
    // The stream sends one update per signal every 5 s; jump ahead twice so that the price has
    // moved and the update that follows it has been sent.
    await page.clock.fastForward('10:00');
    await page.clock.fastForward('10:00');
    await expect.poll(async () => live.textContent()).not.toBe(before);
    await expect(live).toHaveText(/^[+-]?\d\.\d{2}R$/);
    expect(
      await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
    ).toBe(true);
  });
});

test.describe('E6 insufficient evidence', () => {
  test('under 30 trades the card shows the counts and no percentage', async ({ page }) => {
    await logIn(page, { scenario: 'two-open' });
    const evidence = card(page, 43).getByTestId('signal-evidence');
    await expect(evidence).toContainText('Insufficient evidence');
    await expect(evidence).toContainText('18 resolved trades');
    await expect(evidence).toContainText('10 wins');
    expect(await evidence.textContent()).not.toContain('%');
    await expect(evidence.getByTestId('evidence-win-rate')).toHaveCount(0);
    // The first card has 64 trades: a rate with its interval and the low-sample label.
    await expect(card(page, 42).getByTestId('evidence-win-rate')).toHaveText('58%');
    await expect(card(page, 42).getByTestId('signal-evidence')).toContainText('Low sample');
  });

  test('the month counter has fewer than 30 results and shows no win rate either', async ({
    page,
  }) => {
    await logIn(page, { scenario: 'open-buy' });
    await expect(page.getByTestId('month-win-rate')).toHaveText(
      'Win rate: Insufficient evidence (12 results)',
    );
  });
});

test.describe('E3 stale feed', () => {
  test('red banner, DATA_STALE in the card, blocked engine; recovery clears them', async ({
    page,
  }) => {
    await logIn(page, { scenario: 'stale' });
    const banner = page.getByTestId('feed-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText('DATA STALE');
    await expect(card(page, 42).getByTestId('signal-state')).toHaveText('DATA_STALE');
    await expect(card(page, 42)).toContainText('cannot be tracked');
    await expect(page.getByTestId('status-freshness')).toHaveText('STALE');
    await expect(page.getByTestId('status-engine')).toHaveText('BLOCKED: NO DATA');
    await expect(page.getByTestId('engine-reasons')).toContainText('new signals are blocked');

    // The banner is on every private screen, not only on the dashboard.
    await page.getByRole('link', { name: 'News', exact: true }).first().click();
    await expect(page.getByTestId('feed-banner')).toBeVisible();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();

    // Recovery: the feed is back.
    await page.getByTestId('preview-scenario').selectOption('open-buy');
    await expect(page.getByTestId('feed-banner')).toHaveCount(0);
    await expect(card(page, 42).getByTestId('signal-state')).toHaveText('ACTIVE');
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
    await expect(page.getByTestId('status-freshness')).toHaveText(/^FRESH/);
  });

  test('a disconnected feed has its own banner', async ({ page }) => {
    await logIn(page, { scenario: 'disconnected' });
    await expect(page.getByTestId('feed-banner')).toContainText('FEED DISCONNECTED');
    await expect(page.getByTestId('status-freshness')).toHaveText('DISCONNECTED');
  });
});

test.describe('other states of the signal column', () => {
  test('warming up shows the progress and the missing timeframes', async ({ page }) => {
    await logIn(page, { scenario: 'warming-up' });
    const warming = page.getByTestId('warming-up');
    await expect(warming).toContainText('62%');
    await expect(warming.getByTestId('warmup-missing')).toContainText('1h');
    await expect(warming.getByTestId('warmup-missing')).toContainText('4h');
    await expect(page.getByTestId('status-freshness')).toHaveText('WARMING UP 62%');
    await expect(page.getByTestId('status-engine')).toHaveText('WARMING UP');
  });

  test('market closed is grey with the last price and its time', async ({ page }) => {
    await logIn(page, { scenario: 'market-closed' });
    await expect(page.getByTestId('market-closed')).toContainText(/Last price \d{4}\.\d{3} at /);
    await expect(page.getByTestId('status-freshness')).toHaveText('MARKET CLOSED');
    await expect(page.getByTestId('feed-banner')).toHaveCount(0);
  });

  test('after TP1 the stop is shown at break-even', async ({ page }) => {
    await logIn(page, { scenario: 'tp1-hit' });
    await expect(card(page, 42).getByTestId('signal-state')).toHaveText('TP1 HIT');
    await expect(card(page, 42).getByTestId('signal-stop')).toHaveText('4017.370');
  });

  test('pausing asks first, shows the amber card and resumes with one click', async ({ page }) => {
    await logIn(page, { scenario: 'open-buy' });
    await page.getByTestId('pause-button').click();
    const dialog = page.getByRole('dialog', { name: 'Pause the engine?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
    await dialog.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('paused-card')).toBeVisible();
    await expect(page.getByTestId('status-engine')).toHaveText('PAUSED');
    await expect(card(page, 42)).toBeVisible();
    await page.getByTestId('resume-button').click();
    await expect(page.getByTestId('paused-card')).toHaveCount(0);
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
  });
});

test.describe('the chart', () => {
  test('draws on a canvas, shows its overlays and levels as text and logs no error', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the phone opens the chart on demand (see E15)');
    const errors = collectErrors(page);
    await logIn(page, { scenario: 'two-open' });
    const chart = page.getByTestId('price-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('canvas').first()).toBeVisible();
    expect((await box(chart)).width).toBeGreaterThan(500);
    // The chart really drew something: at least one canvas holds more than one colour.
    const drawn = await chart.locator('canvas').evaluateAll((canvases) =>
      canvases.some((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext('2d');
        if (!context || canvas.width === 0 || canvas.height === 0) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 4; i < data.length; i += 4) {
          if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2])
            return true;
        }
        return false;
      }),
    );
    expect(drawn).toBe(true);
    await expect(
      page.getByRole('group', { name: /XAUUSD 5m candlestick chart\. Last close \d{4}\.\d{3}/ }),
    ).toBeVisible();
    await expect(page.getByTestId('legend-ema20')).toHaveText(/^EMA 20 \d{4}\.\d{3}$/);
    await expect(page.getByTestId('level-pdh')).toHaveText(/^PDH \d{4}\.\d{3}$/);

    await page.getByTestId('chart-timeframe').getByText('15m', { exact: true }).click();
    await expect(page.getByRole('group', { name: /XAUUSD 15m candlestick chart/ })).toBeVisible();
    await page.getByTestId('chart-overlays').getByText('Fibonacci', { exact: true }).click();
    await page.getByTestId('chart-overlays').getByText('Patterns', { exact: true }).click();
    await expect(chart.locator('canvas').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('E15 responsive', () => {
  test('phone: bottom tabs, the documented order of the sections, no sideways scroll', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'phone only');
    await logIn(page, { scenario: 'two-open' });
    await expect(
      page.getByRole('navigation', { name: 'Main navigation, bottom tabs' }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main navigation', exact: true }),
    ).toBeHidden();

    const order = ['status-price', 'open-signals', 'chart-section', 'counters', 'events-card'];
    let previousY = -1;
    for (const testId of order) {
      const y = (await box(page.getByTestId(testId))).y;
      expect(y, `${testId} comes after the previous section`).toBeGreaterThan(previousY);
      previousY = y;
    }
    // Inside a card the order is: levels and live R, why this signal, then the evidence.
    const levelsY = (await box(card(page, 42).getByTestId('signal-entry'))).y;
    const whyY = (await box(card(page, 42).getByTestId('signal-why-group-trend'))).y;
    const evidenceY = (await box(card(page, 42).getByTestId('signal-evidence'))).y;
    expect(levelsY).toBeLessThan(whyY);
    expect(whyY).toBeLessThan(evidenceY);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('phone: the chart starts collapsed and opens on demand', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone only');
    const errors = collectErrors(page);
    await logIn(page, { scenario: 'two-open' });
    await expect(page.getByTestId('price-chart')).toHaveCount(0);
    await page.getByRole('button', { name: 'Chart' }).click();
    await expect(page.getByTestId('price-chart')).toBeVisible();
    await expect(page.getByTestId('price-chart').locator('canvas').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('phone: no sideways scroll in any state', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone only');
    await logIn(page, { scenario: 'wait' });
    for (const id of ['wait', 'warming-up', 'stale', 'market-closed', 'paused', 'tp1-hit']) {
      await page.getByTestId('preview-scenario').selectOption(id);
      await expect(page.getByTestId('open-signals')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, id).toBeLessThanOrEqual(0);
    }
  });

  test('desktop: navigation rail on the left, chart left of the signals', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'desktop only');
    await logIn(page, { scenario: 'two-open' });
    await expect(
      page.getByRole('navigation', { name: 'Main navigation', exact: true }),
    ).toBeVisible();
    const rail = await box(page.locator('.mantine-AppShell-navbar'));
    const chart = await box(page.getByTestId('chart-section'));
    const signals = await box(page.getByTestId('open-signals'));
    expect(rail.x).toBeLessThan(chart.x);
    expect(chart.x + chart.width).toBeLessThanOrEqual(signals.x + 1);
    // Two columns: the tops are level.
    expect(Math.abs(chart.y - signals.y)).toBeLessThan(8);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('E16 accessibility of every state', () => {
  // an axe run on a busy machine can take long: 60 s instead of 30 s
  test.describe.configure({ timeout: 60_000 });
  const scenarios = [
    'two-open',
    'open-buy',
    'tp1-hit',
    'wait',
    'warming-up',
    'stale',
    'disconnected',
    'market-closed',
    'paused',
  ];

  async function violations(page: Page): Promise<string[]> {
    const results = await new AxeBuilder({ page }).analyze();
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          `${v.id} (${String(v.impact)}): ${v.help} -> ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' ') + ' ' + n.html.slice(0, 140))
            .join(' | ')}`,
      );
  }

  for (const scheme of ['dark', 'light'] as const) {
    for (const scenario of scenarios) {
      test(`${scenario}, ${scheme} theme`, async ({ page }) => {
        await page.addInitScript((value) => {
          window.localStorage.setItem('mantine-color-scheme-value', value);
        }, scheme);
        await logIn(page, { scenario });
        await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
        await expect(page.getByTestId('open-signals')).toBeVisible();
        // The headlines and the counters come from separate calls: wait until they are there.
        await expect(page.getByTestId('news-headlines').getByRole('link').first()).toBeVisible();
        await expect(page.getByTestId('month-win-rate')).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    }
  }

  test('with the "why" rows opened and the pause dialog shown', async ({ page }) => {
    await logIn(page, { scenario: 'two-open' });
    const trend = card(page, 42).getByTestId('signal-why-group-trend');
    await trend.getByRole('button').click();
    await expect(trend.getByRole('listitem').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByTestId('pause-button').click();
    await expect(page.getByRole('dialog', { name: 'Pause the engine?' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
