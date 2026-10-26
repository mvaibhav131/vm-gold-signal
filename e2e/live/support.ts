import { createHmac } from 'node:crypto';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** The owner of the live stack (the one of the API test harness). */
export const OWNER = { username: 'owner', password: 'correct horse battery staple' } as const;

export const SITE = 'http://127.0.0.1:4174';

/** The hand on the simulated worker (apps/api/src/testing/liveControl.ts). */
const CONTROL = 'http://127.0.0.1:3001';

/** Something that happens in the stack while a page is open: a signal is made, the feed goes quiet, the worker dies. */
export async function control(request: APIRequestContext, path: string): Promise<unknown> {
  const response = await request.post(`${CONTROL}${path}`);
  expect(response.ok(), `control ${path} answered ${String(response.status())}`).toBe(true);
  return response.json();
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = '';
  for (const letter of text.replaceAll('=', '').toUpperCase()) {
    const value = BASE32.indexOf(letter);
    if (value < 0) throw new Error(`not a base32 secret: ${letter}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let at = 0; at + 8 <= bits.length; at += 8)
    bytes.push(Number.parseInt(bits.slice(at, at + 8), 2));
  return Buffer.from(bytes);
}

const PERIOD_S = 30;

/** The code of an authenticator app (RFC 6238: SHA-1, 6 digits, 30 seconds) for one step. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * A code the API will take: it accepts a step one either side of its own and never a step it has taken already, so the
 * next code is the one for the step after the last that was used. When that step is more than one ahead of the clock the
 * API would refuse it, and this waits for the clock to come within reach (at most 30 seconds).
 */
export async function nextTotp(
  secret: string,
  lastStep: number,
): Promise<{ code: string; step: number }> {
  for (;;) {
    const now = Math.floor(Date.now() / 1000 / PERIOD_S);
    const step = Math.max(now, lastStep + 1);
    if (step <= now + 1) return { code: totpAt(secret, step), step };
    const wait = (now + 1) * PERIOD_S * 1000 - Date.now() + 250;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Everything that goes wrong on a page, in words: what the owner would not see in the DOM. The first look at the session
 * (`/auth/me`) of a visitor who is not logged in is a 401 by design, so `logIn` starts the watch after it.
 */
const shorten = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');

export function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console ${message.type()}: ${message.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.slice(0, 300)}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(
        `HTTP ${String(response.status())} ${response.request().method()} ${shorten(response.url())}`,
      );
    }
  });
  page.on('requestfailed', (request) =>
    problems.push(`request failed ${shorten(request.url())} ${request.failure()?.errorText ?? ''}`),
  );
  return problems;
}

/** Logs in through the login page, like the owner, and returns the list of problems from then on. */
export async function logIn(page: Page): Promise<string[]> {
  await page.goto('/login');
  await page.getByLabel(/^username/i).fill(OWNER.username);
  await page.getByLabel(/^password/i).fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return watch(page);
}

/** The text of the page body, on one line. */
export async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replaceAll(/\s+/g, ' ');
}

/** Opens a route and waits for its heading: a route that does not load is a failure with its own name. */
export async function openScreen(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

/** The order of the owner on the page: no network error, no console error, no failed request since the last check. */
export function expectNoProblems(problems: string[]): void {
  expect(problems, 'problems seen by the browser').toEqual([]);
}

/** The server ends the session of this browser behind the back of the page (what another device or an expiry does). */
export async function endSessionOnServer(page: Page): Promise<void> {
  const response = await page.request.post('/api/v1/auth/logout', {
    headers: { origin: SITE, 'x-vmgs-csrf': '1' },
  });
  expect(response.status()).toBe(204);
}
