import { expect, type Page } from '@playwright/test';

export const OWNER = { username: 'owner', password: 'preview' } as const;

export async function fillLogin(page: Page, password: string = OWNER.password): Promise<void> {
  await page.getByLabel(/^username/i).fill(OWNER.username);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/**
 * Logs in through the real login screen and waits until the status bar has its data. The preview
 * state of the simulated market can be chosen with `scenario` (see the picker on the dashboard).
 */
export async function logIn(page: Page, options: { scenario?: string } = {}): Promise<void> {
  await page.goto(options.scenario ? `/login?scenario=${options.scenario}` : '/login');
  await fillLogin(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByTestId('status-mode')).toHaveText('SIMULATED');
  await expect(page.getByTestId('status-strategy')).toHaveText('FORWARD-TEST');
}

/** The routes of 05_UI_Spec section 2 that sit behind the login. */
export const PRIVATE_ROUTES = [
  { path: '/', heading: 'Dashboard' },
  { path: '/signals', heading: 'Signals' },
  { path: '/signals/S-0042', heading: 'Signal detail' },
  { path: '/analytics', heading: 'Analytics' },
  { path: '/news', heading: 'News' },
  { path: '/system', heading: 'System' },
] as const;
