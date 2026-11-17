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
  test('zooms with the buttons and the wheel, shows the numbers of a candle and the last candle is live', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the phone opens the chart on demand (see E15)');
    const errors = collectErrors(page);
    await logIn(page, { scenario: 'two-open' });
    const chart = page.getByTestId('price-chart');
    await expect(chart.locator('canvas').first()).toBeVisible();

    // The first view shows the newest 120 candles of the 5 minute chart, not all 600 that were loaded.
    const bars = async () => Number(await chart.getAttribute('data-visible-bars'));
    await expect.poll(bars).toBeGreaterThan(100);
    const first = await bars();
    expect(first).toBeLessThan(160);

    const tools = page.getByTestId('chart-tools');
    await tools.getByRole('button', { name: /zoom out/i }).click();
    await expect.poll(bars).toBeGreaterThan(first * 1.3);
    await tools.getByRole('button', { name: /zoom in/i }).click();
    await tools.getByRole('button', { name: /zoom in/i }).click();
    await expect.poll(bars).toBeLessThan(first * 0.8);
    await tools.getByRole('button', { name: 'Reset the view' }).click();
    await expect.poll(async () => Math.abs((await bars()) - first)).toBeLessThan(4);

    // The mouse wheel zooms too.
    const rect = (await chart.boundingBox()) ?? { x: 0, y: 0, width: 600, height: 400 };
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.wheel(0, -600);
    await expect.poll(bars).toBeLessThan(first);

    // The numbers of the newest candle are written above the chart, and the forming candle moves with every quote (with the
    // pointer off the chart: on a candle they show that candle).
    await page.mouse.move(5, 5);
    const numbers = page.getByTestId('chart-numbers');
    await expect(numbers).toHaveText(
      /^O \d{4}\.\d{3} {2}H \d{4}\.\d{3} {2}L \d{4}\.\d{3} {2}C \d{4}\.\d{3}/,
    );
    const before = await numbers.textContent();
    await expect(numbers).not.toHaveText(before ?? '', { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
});

test.describe('the chart tools', () => {
  async function openChart(page: Page, isMobile: boolean) {
    await logIn(page, { scenario: 'two-open' });
    // the phone opens the chart on demand
    if (isMobile) await page.getByRole('button', { name: 'Chart', exact: true }).click();
    const chart = page.getByTestId('price-chart');
    await expect(chart.locator('canvas').first()).toBeVisible();
    await expect(chart).toHaveAttribute('data-panes', '1');
    return chart;
  }

  test('indicators go over the price or into panes under it, with their numbers, and can be taken away', async ({
    page,
    isMobile,
  }) => {
    const errors = collectErrors(page);
    const chart = await openChart(page, isMobile);

    await page.getByTestId('indicators-button').click();
    await page.getByRole('checkbox', { name: 'RSI', exact: true }).check();
    await page.getByRole('checkbox', { name: 'MACD', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Bollinger Bands', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('indicators-menu')).toBeHidden();
    await expect(page.getByTestId('indicators-button')).toHaveText('Indicators (3)');

    // the price, the RSI and the MACD each have a pane; the Bollinger bands are over the price
    await expect(chart).toHaveAttribute('data-panes', '3');
    await expect(page.getByTestId('indicator-rsi').locator('[data-ind]')).toHaveText(
      /^RSI\s+\d{1,3}\.\d{2}$/,
    );
    await expect(page.getByTestId('indicator-macd').locator('[data-ind]')).toHaveText(
      /^Hist\s+-?\d+\.\d{3}\s+MACD\s+-?\d+\.\d{3}\s+Signal\s+-?\d+\.\d{3}$/,
    );
    await expect(page.getByTestId('indicator-bollinger').locator('[data-ind]')).toHaveText(
      /^Upper\s+\d{4}\.\d{3}\s+Mid\s+\d{4}\.\d{3}\s+Lower\s+\d{4}\.\d{3}$/,
    );

    // a change of the type of chart keeps them
    await page.getByTestId('chart-type').getByText('Line', { exact: true }).click();
    await expect(chart).toHaveAttribute('data-type', 'line');
    await expect(chart).toHaveAttribute('data-panes', '3');

    // taking one away from its legend closes its pane
    await page.getByRole('button', { name: 'Remove RSI', exact: true }).click();
    await expect(chart).toHaveAttribute('data-panes', '2');
    await expect(page.getByTestId('indicator-rsi')).toHaveCount(0);
    await page.getByRole('button', { name: 'Remove Bollinger Bands', exact: true }).click();
    await page.getByRole('button', { name: 'Remove MACD', exact: true }).click();
    await expect(chart).toHaveAttribute('data-panes', '1');
    await expect(page.getByTestId('indicator-legend')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the time to the close of the candle counts down, for the timeframe that is shown', async ({
    page,
    isMobile,
  }) => {
    const errors = collectErrors(page);
    const chart = await openChart(page, isMobile);
    // 5m: up to 5 minutes; it runs down by the second (the label itself is drawn on the price axis by the chart)
    await expect(chart).toHaveAttribute('data-countdown', /^0[0-4]:\d{2}$|^05:00$/);
    const first = await chart.getAttribute('data-countdown');
    await expect
      .poll(async () => chart.getAttribute('data-countdown'), { timeout: 5000 })
      .not.toBe(first);
    await page.getByTestId('chart-timeframe').getByText('1m', { exact: true }).click();
    await expect(page.getByTestId('price-chart')).toHaveAttribute(
      'data-countdown',
      /^00:\d{2}$|^01:00$/,
    );
    await page.getByTestId('chart-timeframe').getByText('4h', { exact: true }).click();
    // 4h: hours appear when more than an hour is left, and the text is a valid clock either way
    await expect(page.getByTestId('price-chart')).toHaveAttribute(
      'data-countdown',
      /^(?:[0-3]:)?\d{2}:\d{2}$|^4:00:00$/,
    );
    expect(errors).toEqual([]);
  });

  test('the type of chart can be candles, Heikin Ashi or a line, and it is kept for the next visit', async ({
    page,
    isMobile,
  }) => {
    const errors = collectErrors(page);
    const chart = await openChart(page, isMobile);
    await expect(chart).toHaveAttribute('data-type', 'candles');
    for (const [label, type] of [
      ['Heikin Ashi', 'heikin'],
      ['Line', 'line'],
      ['Candles', 'candles'],
    ] as const) {
      await page.getByTestId('chart-type').getByText(label, { exact: true }).click();
      await expect(chart).toHaveAttribute('data-type', type);
      await expect(chart.locator('canvas').first()).toBeVisible();
    }
    await page.getByTestId('chart-type').getByText('Heikin Ashi', { exact: true }).click();
    await expect(chart).toHaveAttribute('data-type', 'heikin');
    const kept = await page.evaluate(() => window.localStorage.getItem('vmgs.chart.prefs.v1'));
    expect(JSON.parse(kept ?? '{}')).toMatchObject({ chartType: 'heikin' });
    expect(errors).toEqual([]);
  });

  test('drawings: a horizontal line, a trendline and a Fibonacci retracement, then undo and clear', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'drawing is checked with the mouse');
    const errors = collectErrors(page);
    const chart = await openChart(page, isMobile);
    await expect(chart).toHaveAttribute('data-drawings', '0');
    const hint = page.getByTestId('chart-hint');
    const draw = async (name: string, hintText: RegExp) => {
      await page.getByTestId('draw-button').click();
      await page.getByRole('menuitem', { name }).click();
      // the menu fades out over the chart: wait for it to be gone before clicking on the chart
      await expect(page.getByTestId('draw-menu')).toBeHidden();
      await expect(hint).toHaveText(hintText);
    };
    // Two clicks within half a second are a double click for the chart, which is not a click: a person takes longer between
    // two points, and so does this test.
    let lastClickAt = 0;
    const click = async (fx: number, fy: number) => {
      const wait = 600 - (Date.now() - lastClickAt);
      if (wait > 0) await page.waitForTimeout(wait);
      const rect = await box(chart);
      await page.mouse.click(rect.x + rect.width * fx, rect.y + rect.height * fy);
      lastClickAt = Date.now();
    };

    await draw('Horizontal line', /^Horizontal line: click the price/);
    await click(0.5, 0.4);
    await expect(chart).toHaveAttribute('data-drawings', '1');
    await expect(chart).toHaveAttribute('data-drawn', '1');
    await expect(hint).toHaveText('');
    await expect(page.getByTestId('draw-button')).toHaveText('Draw');

    await draw('Trendline', /^Trendline: click the first point/);
    await click(0.3, 0.6);
    await expect(hint).toHaveText(/click the second point/);
    await click(0.7, 0.3);
    await expect(chart).toHaveAttribute('data-drawings', '2');
    await expect(chart).toHaveAttribute('data-drawn', '2');

    await draw('Fibonacci retracement', /^Fibonacci retracement: click the first point/);
    await click(0.2, 0.7);
    await click(0.6, 0.35);
    await expect(chart).toHaveAttribute('data-drawings', '3');
    // the dotted segment and the seven levels
    await expect(chart).toHaveAttribute('data-drawn', '10');

    // Escape puts the tool away without drawing anything
    await draw('Horizontal line', /click the price/);
    await page.keyboard.press('Escape');
    await expect(hint).toHaveText('');
    await expect(chart).toHaveAttribute('data-drawings', '3');

    await page.getByTestId('draw-button').click();
    await page.getByRole('menuitem', { name: 'Undo the last drawing' }).click();
    await expect(chart).toHaveAttribute('data-drawings', '2');
    await expect(chart).toHaveAttribute('data-drawn', '2');
    const kept = await page.evaluate(() => window.localStorage.getItem('vmgs.chart.drawings.v1'));
    expect(JSON.parse(kept ?? '[]')).toHaveLength(2);
    await page.getByTestId('draw-button').click();
    await page.getByRole('menuitem', { name: 'Clear all drawings' }).click();
    await expect(chart).toHaveAttribute('data-drawings', '0');
    await expect(chart).toHaveAttribute('data-drawn', '0');
    expect(errors).toEqual([]);
  });

  test('full screen lays the chart over the whole window, and Escape or the button puts it back', async ({
    page,
    isMobile,
  }) => {
    const errors = collectErrors(page);
    const chart = await openChart(page, isMobile);
    const panel = page.getByTestId('chart-panel');
    const view = page.viewportSize() ?? { width: 0, height: 0 };
    const normal = await box(chart);

    await page.getByTestId('chart-fullscreen').click();
    await expect(panel).toHaveAttribute('data-fullscreen', 'true');
    await expect(page.getByTestId('chart-fullscreen')).toHaveText('Exit full screen');
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    await expect.poll(async () => (await box(panel)).width).toBeGreaterThanOrEqual(view.width - 1);
    await expect
      .poll(async () => (await box(panel)).height)
      .toBeGreaterThanOrEqual(view.height - 1);
    // the chart takes the room that the controls leave, and draws again at its new size
    await expect.poll(async () => (await box(chart)).width).toBeGreaterThan(view.width - 40);
    await expect.poll(async () => (await box(chart)).height).toBeGreaterThan(normal.height * 0.7);
    await expect(chart.locator('canvas').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveAttribute('data-fullscreen', 'false');
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

    await page.getByTestId('chart-fullscreen').click();
    await expect(panel).toHaveAttribute('data-fullscreen', 'true');
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(panel).toHaveAttribute('data-fullscreen', 'false');
    expect(errors).toEqual([]);
  });

  test('phone: the controls fit the screen and the menus open inside it', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'phone only');
    const chart = await openChart(page, isMobile);
    const view = page.viewportSize() ?? { width: 0, height: 0 };
    for (const id of ['chart-type', 'indicators-button', 'draw-button', 'chart-fullscreen']) {
      const rect = await box(page.getByTestId(id));
      expect(rect.x, id).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, id).toBeLessThanOrEqual(view.width + 1);
      expect(rect.height, id).toBeGreaterThanOrEqual(22);
    }
    for (const [button, menu] of [
      ['indicators-button', 'indicators-menu'],
      ['draw-button', 'draw-menu'],
    ] as const) {
      await page.getByTestId(button).click();
      await expect(page.getByTestId(menu)).toBeVisible();
      const rect = await box(page.getByTestId(menu));
      expect(rect.x, menu).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, menu).toBeLessThanOrEqual(view.width + 1);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(menu)).toBeHidden();
    }
    // a pane under the price still leaves the price a usable height on a phone
    await page.getByTestId('indicators-button').click();
    await page.getByRole('checkbox', { name: 'RSI', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(chart).toHaveAttribute('data-panes', '2');
    expect((await box(chart)).height).toBeGreaterThan(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('the chart (basics)', () => {
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
