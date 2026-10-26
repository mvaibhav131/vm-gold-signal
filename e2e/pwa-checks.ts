import { expect, type Page } from '@playwright/test';

// What the app has to be to install and to receive a push (05_UI_Spec E17, 04 section 5), as a browser sees it. Used by the
// scenarios of the preview, and by the look at a running stack (e2e/stack): the same checks, on the page of whatever origin.

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

/** The size of a PNG from its header, and whether it is one at all. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function expectPng(page: Page, path: string, size: number): Promise<void> {
  const response = await page.request.get(path);
  expect(response.status(), `${path} answers`).toBe(200);
  expect(response.headers()['content-type'], `${path} is an image`).toBe('image/png');
  expect(pngSize(await response.body()), `${path} is a PNG of ${String(size)} pixels`).toEqual({
    width: size,
    height: size,
  });
}

/** The manifest, its icons, and the tags of the page that point at them. */
export async function expectInstallable(
  page: Page,
  options: { manifestType?: RegExp } = {},
): Promise<Manifest> {
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  const response = await page.request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    options.manifestType ?? /^application\/(manifest\+)?json/,
  );
  const manifest = (await response.json()) as Manifest;
  expect(manifest).toMatchObject({
    name: 'VM Gold Signal',
    short_name: 'VM Gold',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0B0F14',
    theme_color: '#0B0F14',
  });
  // the colour of the browser bar is the colour of the manifest
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    manifest.theme_color,
  );

  expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose} ${icon.type}`)).toEqual([
    '192x192 any image/png',
    '512x512 any image/png',
    '512x512 maskable image/png',
  ]);
  for (const icon of manifest.icons) await expectPng(page, icon.src, Number.parseInt(icon.sizes));

  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/apple-touch-icon.png',
  );
  await expectPng(page, '/icons/apple-touch-icon.png', 180);
  await expectPng(page, '/icons/badge-96.png', 96);
  const favicon = await page.request.get('/favicon.svg');
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()['content-type']).toContain('image/svg+xml');
  return manifest;
}

/**
 * The service worker is registered for the whole site, is active, and keeps nothing: it has no cache and no `fetch`
 * handler, so no answer of the API is ever stored on the device.
 */
export async function expectWorkerThatCachesNothing(page: Page): Promise<void> {
  const look = () =>
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        scope: registration.scope,
        script: registration.active?.scriptURL ?? null,
        state: registration.active?.state ?? null,
      };
    });
  // `ready` is there when the worker has taken over; for a moment after that it is still finishing its activation
  await expect.poll(async () => (await look()).state).toBe('activated');
  const worker = await look();
  expect(worker.scope).toBe(`${new URL(page.url()).origin}/`);
  expect(worker.script).toBe(`${new URL(page.url()).origin}/sw.js`);

  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  const source = await (await page.request.get('/sw.js')).text();
  expect(source).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
  expect(source).not.toMatch(/\bcaches\b/);
}

export interface ShownNotification {
  title: string;
  body: string;
  tag: string;
  data: unknown;
}

/** The notifications that the worker has put up and that nobody has closed. */
export function shownNotifications(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((each) => ({
      title: each.title,
      body: each.body,
      tag: each.tag,
      data: each.data as unknown,
    }));
  });
}

/**
 * Sends a push to the worker of the page the way a push service would (the browser's own protocol tool, so the push event
 * runs in the real worker). Needs the permission for notifications, which this gives to the origin of the page.
 */
export async function deliverPush(page: Page, message: unknown): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(['notifications'], { origin });
  const session = await page.context().newCDPSession(page);
  const registrations = new Map<string, string>();
  session.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: updated }) => {
    for (const each of updated) registrations.set(each.scopeURL, each.registrationId);
  });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => registrations.get(`${origin}/`)).toBeDefined();
  const registrationId = registrations.get(`${origin}/`);
  if (registrationId === undefined) throw new Error('the page has no service worker registration');
  await session.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId,
    data: JSON.stringify(message),
  });
}
