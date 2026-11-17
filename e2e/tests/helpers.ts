import { expect, type Page } from '@playwright/test';

export const OWNER = { username: 'owner', password: 'preview' } as const;

export async function fillLogin(page: Page, password: string = OWNER.password): Promise<void> {
  await page.getByLabel(/^username/i).fill(OWNER.username);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/**
 * The width of the text depends on the fonts of the machine: the CI (Linux) has a wider font than Windows, and a layout that
 * fits here can wrap there. To see here what the CI sees, run with VMGS_TEST_FONT=Verdana (about the width of the CI font);
 * without it the font of this PC is used.
 */
async function useTestFont(page: Page): Promise<void> {
  const family = process.env.VMGS_TEST_FONT;
  if (family === undefined || family === '') return;
  await page.addInitScript((name) => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `:root{--mantine-font-family:${name} !important} body,button,input,select,textarea{font-family:${name} !important}`;
      document.head.append(style);
    });
  }, family);
}

/**
 * Logs in through the real login screen and waits until the status bar has its data. The preview
 * state of the simulated market can be chosen with `scenario` (see the picker on the dashboard).
 */
export async function logIn(page: Page, options: { scenario?: string } = {}): Promise<void> {
  await useTestFont(page);
  await page.goto(options.scenario ? `/login?scenario=${options.scenario}` : '/login');
  await fillLogin(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByTestId('status-mode')).toHaveText('SIMULATED');
  await expect(page.getByTestId('status-strategy')).toHaveText('FORWARD-TEST');
}

/** The routes of 05_UI_Spec section 2 that sit behind the login. The signal is S-0041, a finished one in every preview state. */
export const PRIVATE_ROUTES = [
  { path: '/', heading: 'Dashboard' },
  { path: '/signals', heading: 'Signals' },
  { path: '/signals/00000000-0000-4000-8000-000000000029', heading: 'Signal detail' },
  { path: '/analytics', heading: 'Analytics' },
  { path: '/news', heading: 'News' },
  { path: '/system', heading: 'System' },
] as const;
