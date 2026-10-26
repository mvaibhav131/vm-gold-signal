import { expect, type Page } from '@playwright/test';

/** The owner of the live stack (the one of the API test harness). */
export const OWNER = { username: 'owner', password: 'correct horse battery staple' } as const;

export const SITE = 'http://127.0.0.1:4174';

/**
 * Everything that goes wrong on a page, in words: what the owner would not see in the DOM. The first look at the session
 * (`/auth/me`) of a visitor who is not logged in is a 401 by design, so `logIn` starts the watch after it.
 */
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
        `HTTP ${String(response.status())} ${response.request().method()} ${response.url().replace(SITE, '')}`,
      );
    }
  });
  page.on('requestfailed', (request) =>
    problems.push(
      `request failed ${request.url().replace(SITE, '')} ${request.failure()?.errorText ?? ''}`,
    ),
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
