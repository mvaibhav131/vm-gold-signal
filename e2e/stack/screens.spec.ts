import { expect, test, type Page } from '@playwright/test';

import { bodyText, expectNoProblems, openScreen, watch } from '../live/support';
import { expectInstallable, expectWorkerThatCachesNothing } from '../pwa-checks';

// The site on a running stack, read only (see playwright.stack.config.ts). What a browser can tell that a request cannot: the
// headers of Caddy and its policy for scripts and styles (a page that the policy breaks is blank, with an error in the console),
// the event stream through the proxy (the price moves), the cookie over HTTPS, and every screen with real data.

const SCREENS = [
  ['/', 'Dashboard'],
  ['/signals', 'Signals'],
  ['/analytics', 'Analytics'],
  ['/news', 'News'],
  ['/news?tab=headlines', 'News'],
  ['/news?tab=moves', 'News'],
  ['/system', 'System'],
  ['/system?tab=storage', 'System'],
  ['/system?tab=strategies', 'System'],
  ['/system?tab=alerts', 'System'],
  ['/system?tab=display', 'System'],
  ['/system?tab=security', 'System'],
] as const;

function credentials(): { user: string; pass: string; code: string | undefined } {
  const pass = process.env.VMGS_STACK_PASS;
  if (pass === undefined || pass === '') {
    throw new Error(
      'set VMGS_STACK_PASS (and VMGS_STACK_USER, VMGS_STACK_CODE if needed): the owner of the stack',
    );
  }
  return { user: process.env.VMGS_STACK_USER ?? 'owner', pass, code: process.env.VMGS_STACK_CODE };
}

async function logIn(page: Page): Promise<string[]> {
  const { user, pass, code } = credentials();
  await page.goto('/login');
  await page.getByLabel(/^username/i).fill(user);
  await page.getByLabel(/^password/i).fill(pass);
  if (code !== undefined) await page.getByLabel(/authenticator code/i).fill(code);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return watch(page);
}

test('Caddy sends the headers of the design, and the login page is a working page under its policy', async ({
  page,
}) => {
  const problems = watch(page);
  const response = await page.goto('/login');
  const headers = response?.headers() ?? {};
  expect(headers['strict-transport-security']).toMatch(/max-age=\d+/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['cache-control']).toBe('no-cache');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  // a visitor with no session gets 401 from `me`, by design: nothing else may fail
  expect(
    problems.filter((line) => !line.includes('/api/v1/auth/me') && !line.includes('401')),
  ).toEqual([]);
});

test('every screen loads on the real API with no console error, no refused request and no policy violation', async ({
  page,
}) => {
  const problems = await logIn(page);
  for (const [path, heading] of SCREENS) {
    await test.step(path, async () => {
      await openScreen(page, path, heading);
      await expect(page.locator('.mantine-Skeleton-root')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await bodyText(page)).not.toMatch(/Could not load|Retrying/);
    });
  }
  expectNoProblems(problems);
});

test('the price of the status bar moves: the event stream reaches the browser through the proxy', async ({
  page,
}) => {
  await logIn(page);
  const price = page.getByTestId('status-price');
  await expect(price).toContainText(/\d{3,5}\.\d{2,3}/);
  const chip = page.getByTestId('status-freshness');
  test.skip(
    (await chip.innerText()).includes('MARKET CLOSED'),
    'the market is closed: no tick to see',
  );
  const first = await price.innerText();
  await expect.poll(() => price.innerText(), { timeout: 90_000 }).not.toBe(first);
  await expect(chip).toHaveText(/^(FRESH|WARMING UP)/);
});

test('the app can be installed: a manifest of the right type, real icons, and a worker that caches nothing', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expectInstallable(page, { manifestType: /^application\/manifest\+json/ });
  await expectWorkerThatCachesNothing(page);
  // the worker is checked at every visit, so that a new release reaches the phone
  const worker = await page.request.get('/sw.js');
  expect(worker.headers()['cache-control']).toBe('no-cache');
  expect(worker.headers()['content-type']).toMatch(/javascript/);
});

test('the Web Push section knows what this browser and the server can do, whichever it is', async ({
  page,
}) => {
  await logIn(page);
  await openScreen(page, '/system?tab=alerts', 'System');
  const note = page.getByTestId('alerts-webpush-note');
  await expect(note).not.toContainText(/Looking at this device|could not be read|preview/);
  // set up on the server or not, it is said in words
  await expect(note).toContainText(
    /No device is subscribed|not set up on the server|subscribed|blocked/,
  );
});

test('the worker is heard from, and the owner can log out', async ({ page }) => {
  const problems = await logIn(page);
  await openScreen(page, '/system', 'System');
  await expect(page.locator('main')).toContainText(/Heartbeat\s+\d+ s ago/, { useInnerText: true });
  await expect(page.locator('main')).toContainText('Reachable');
  expectNoProblems(problems);

  // what the page says after its logout (the stream it closes, a last question that is refused) is not looked at
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/signals');
  await expect(page).toHaveURL(/\/login$/);
});
