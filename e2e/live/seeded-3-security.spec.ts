import { expect, test, type Browser, type Page } from '@playwright/test';

import { OWNER, SITE, control, expectNoProblems, logIn, nextTotp, totpAt } from './support';

// The security flows on the real API (phase U5c): the password, the 2-step login with codes that a real authenticator would
// make, and the sessions of other browsers. The owner of the stack is one: every scenario leaves it as it found it (the
// password as it was, the 2-step login off), because the scenarios of a world share one stack.

const NEW_PASSWORD = 'a much longer password';

async function openSecurity(page: Page): Promise<void> {
  await page.goto('/system?tab=security');
  await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
}

/** A second browser, signed in as the owner: what his phone is. */
async function otherBrowser(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: SITE });
  const page = await context.newPage();
  await logIn(page);
  return { page, close: () => context.close() };
}

async function fillPasswordForm(page: Page, current: string, next: string): Promise<void> {
  await page.getByLabel('Current password').fill(current);
  await page.getByLabel('New password', { exact: true }).fill(next);
  await page.getByLabel('Repeat the new password').fill(next);
  await page.getByTestId('password-submit').click();
}

/** Presses Log in and says what the API answered: a refused login and an accepted one look alike on the page for a moment. */
async function submitLogin(page: Page): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (reply) => reply.url().endsWith('/api/v1/auth/login') && reply.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Log in' }).click(),
  ]);
  return response.status();
}

const sessionRows = (page: Page) => page.getByTestId(/^session-(?!revoke-)/);

test.describe('sessions', () => {
  test('lists this browser without a Revoke button; revoking another asks first and ends only that one', async ({
    page,
    browser,
    request,
  }) => {
    // every login of the scenarios before this one is a session that is still open
    await control(request, '/sessions/revoke-all');
    const problems = await logIn(page);
    const phone = await otherBrowser(browser);
    try {
      await openSecurity(page);
      await expect(sessionRows(page)).toHaveCount(2);
      await expect(page.getByText('This device')).toHaveCount(1);
      const revoke = page.getByTestId(/^session-revoke-(?!confirm$)/);
      await expect(revoke).toHaveCount(1);

      await revoke.click();
      const dialog = page.getByRole('dialog', { name: 'Revoke this session?' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(sessionRows(page)).toHaveCount(2);
      await expect(phone.page).toHaveURL(`${SITE}/`);

      await revoke.click();
      await page.getByTestId('session-revoke-confirm').click();
      await expect(sessionRows(page)).toHaveCount(1);
      // the browser that was revoked is on the login at its next request; this one is still in
      await expect(phone.page).toHaveURL(/\/login$/, { timeout: 20_000 });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
      expectNoProblems(problems);
    } finally {
      await phone.close();
    }
  });
});

test.describe('the password', () => {
  test('says what is wrong, then changes, signs the other browsers out, and the new password logs in', async ({
    page,
    browser,
    request,
  }) => {
    await control(request, '/throttle/reset');
    await logIn(page);
    const phone = await otherBrowser(browser);
    try {
      await openSecurity(page);
      await page.getByTestId('password-submit').click();
      await expect(page.getByText('Enter your current password')).toBeVisible();
      await fillPasswordForm(page, 'not the password', NEW_PASSWORD);
      await expect(page.getByTestId('password-result')).toHaveText(
        'The current password is not right.',
      );

      await fillPasswordForm(page, OWNER.password, NEW_PASSWORD);
      await expect(page.getByTestId('password-result')).toHaveText(
        'Password changed. Every other session was signed out.',
      );
      await expect(sessionRows(page)).toHaveCount(1);
      await expect(phone.page).toHaveURL(/\/login$/, { timeout: 20_000 });

      // the old password does not work any more, the new one does
      await page.getByRole('button', { name: 'Log out' }).click();
      await page.getByLabel(/^username/i).fill(OWNER.username);
      await page.getByLabel(/^password/i).fill(OWNER.password);
      expect(await submitLogin(page)).toBe(401);
      await expect(page.getByTestId('login-error')).toBeVisible();
      await page.getByLabel(/^password/i).fill(NEW_PASSWORD);
      expect(await submitLogin(page)).toBe(204);
      await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();

      // and back
      await page.getByRole('tab', { name: 'Security' }).click();
      await fillPasswordForm(page, NEW_PASSWORD, OWNER.password);
      await expect(page.getByTestId('password-result')).toHaveText(
        'Password changed. Every other session was signed out.',
      );
    } finally {
      await phone.close();
      await control(request, '/throttle/reset');
    }
  });
});

test.describe('the 2-step login', () => {
  test('is set up with a real code, shows eight recovery codes once, is asked at the next login, and is turned off again', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await control(request, '/throttle/reset');
    await logIn(page);
    await openSecurity(page);
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is off.');

    await page.getByTestId('totp-setup').click();
    const panel = page.getByTestId('totp-setup-panel');
    const secret = (await panel.getByTestId('totp-secret').innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // a code that is not right says so and changes nothing
    const now = Math.floor(Date.now() / 1000 / 30);
    const wrong = totpAt(secret, now) === '000000' ? '000001' : '000000';
    await panel.getByTestId('totp-code').fill(wrong);
    await page.getByTestId('totp-enable').click();
    await expect(panel).toContainText('This code is not right.');
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is off.');

    let last = { code: totpAt(secret, now), step: now };
    await panel.getByTestId('totp-code').fill(last.code);
    await page.getByTestId('totp-enable').click();
    const codes = page.getByTestId('totp-recovery-codes');
    await expect(codes.getByRole('listitem')).toHaveCount(8);
    await expect(codes).toContainText('They are shown only now.');
    await page.getByTestId('totp-codes-done').click();
    await expect(codes).toHaveCount(0);
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is on.');

    // the next login needs a code: the password alone is refused
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByLabel(/^username/i).fill(OWNER.username);
    await page.getByLabel(/^password/i).fill(OWNER.password);
    expect(await submitLogin(page)).toBe(401);
    await expect(page.getByTestId('login-error')).toBeVisible();

    // a code is good once: the one that was taken to switch it on is not taken again
    await page.getByLabel(/authenticator code/i).fill(last.code);
    expect(await submitLogin(page)).toBe(401);

    last = await nextTotp(secret, last.step);
    await page.getByLabel(/authenticator code/i).fill(last.code);
    expect(await submitLogin(page)).toBe(204);
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();

    await page.getByRole('tab', { name: 'Security' }).click();
    last = await nextTotp(secret, last.step);
    await page.getByTestId('totp-disable-code').fill(last.code);
    await page.getByTestId('totp-disable').click();
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is off.');
    await expect(page.getByTestId('totp-setup')).toBeVisible();

    // off for real: a login with the password alone works again
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByLabel(/^username/i).fill(OWNER.username);
    await page.getByLabel(/^password/i).fill(OWNER.password);
    expect(await submitLogin(page)).toBe(204);
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
    await control(request, '/throttle/reset');
  });
});
