import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

// The service worker is a plain file (public/sw.js), so these tests run that very file: it is loaded into a context whose
// `self` records the listeners, and each listener is called with the events the browser would make.

const SOURCE = readFileSync(join(__dirname, '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://vmgs.example.org';

type Listener = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function load(windows: FakeClient[] = []) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn((url: string) => {
        opened.push(url);
        return Promise.resolve({});
      }),
    },
    registration: {
      showNotification: vi.fn((title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      }),
    },
  };
  runInNewContext(SOURCE, { self, URL });
  return { self, listeners, shown, opened };
}

/** An event with `waitUntil`: what was handed to it is what the browser waits for. */
function event(extra: Record<string, unknown> = {}) {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    made: {
      ...extra,
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    },
  };
}

const message = (data: unknown) => ({ json: () => data });

async function push(worker: ReturnType<typeof load>, data: { json: () => unknown } | null) {
  const { waits, made } = event({ data });
  worker.listeners.get('push')?.(made);
  await Promise.all(waits);
}

describe('the service worker (public/sw.js)', () => {
  it('has the four listeners of a worker that shows notifications and nothing else: no fetch handler, so no cache', () => {
    const { listeners } = load();
    expect([...listeners.keys()].sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
    ]);
    expect(SOURCE).not.toMatch(/caches\b|CacheStorage|addEventListener\(\s*'fetch'/);
  });

  it('takes over at once: installs without waiting and claims the pages that are open', async () => {
    const worker = load();
    worker.listeners.get('install')?.({});
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
    const { waits, made } = event();
    worker.listeners.get('activate')?.(made);
    await Promise.all(waits);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();
  });

  it('shows what the server pushed: title, body, icon and badge, and the page to open', async () => {
    const worker = load();
    await push(
      worker,
      message({
        title: 'BUY XAUUSD #S-0042 (Strong 78)',
        body: 'Entry 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31',
        url: '/signals/0b9c1f0e-5d1a-4b57-8a43-9f2a1c3d4e5f',
        tag: 'signal:0b9c1f0e:confirmed',
      }),
    );
    expect(worker.shown).toEqual([
      {
        title: 'BUY XAUUSD #S-0042 (Strong 78)',
        options: {
          body: 'Entry 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31',
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-96.png',
          data: { url: '/signals/0b9c1f0e-5d1a-4b57-8a43-9f2a1c3d4e5f' },
          tag: 'signal:0b9c1f0e:confirmed',
          renotify: true,
        },
      },
    ]);
  });

  it('puts no tag on a message that has none, and so replaces nothing and renotifies nothing', async () => {
    const worker = load();
    await push(worker, message({ title: 'TEST', body: 'Delivery works.', url: '/' }));
    const options = worker.shown[0]?.options ?? {};
    expect(options).not.toHaveProperty('tag');
    expect(options).not.toHaveProperty('renotify');
  });

  it('always shows something: a push that cannot be read, has no data, or has an odd shape still makes a notification', async () => {
    for (const data of [
      null,
      {
        json: () => {
          throw new SyntaxError('not json');
        },
      },
      message('text'),
      message(null),
      message(42),
    ]) {
      const worker = load();
      await push(worker, data);
      expect(worker.shown, JSON.stringify(data)).toHaveLength(1);
      expect(worker.shown[0]?.title).toBe('VM Gold Signal');
      expect(worker.shown[0]?.options.body).toBe('There is a new alert. Open the app.');
      expect(worker.shown[0]?.options.data).toEqual({ url: '/' });
    }
    const worker = load();
    await push(worker, message({ title: '   ', body: 7, url: 5, tag: '' }));
    expect(worker.shown[0]?.title).toBe('VM Gold Signal');
    expect(worker.shown[0]?.options).toMatchObject({ body: '', data: { url: '/' } });
    // an empty tag is no tag: it would make every such message replace the one before
    expect(worker.shown[0]?.options).not.toHaveProperty('tag');
  });

  it('cuts a long title, body or tag, so that a message cannot fill the screen', async () => {
    const worker = load();
    await push(
      worker,
      message({ title: 'T'.repeat(500), body: 'B'.repeat(500), url: '/', tag: 'G'.repeat(500) }),
    );
    expect(worker.shown[0]?.title).toHaveLength(300);
    expect(worker.shown[0]?.options.body).toHaveLength(300);
    expect(worker.shown[0]?.options.tag).toHaveLength(200);
  });

  it('opens a page of this site only: the address of another site, or a script, becomes the front page', async () => {
    for (const [url, page] of [
      ['/news?tab=headlines', '/news?tab=headlines'],
      ['/analytics#top', '/analytics#top'],
      [`${ORIGIN}/signals/x`, '/signals/x'],
      ['https://evil.example.net/signals/x', '/'],
      ['//evil.example.net/x', '/'],
      ['javascript:alert(1)', '/'],
      ['http://', '/'],
    ] as const) {
      const worker = load();
      await push(worker, message({ title: 't', body: 'b', url }));
      expect(worker.shown[0]?.options.data, url).toEqual({ url: page });
    }
  });

  describe('a tap on the notification', () => {
    const tap = async (worker: ReturnType<typeof load>, data: unknown) => {
      const close = vi.fn();
      const { waits, made } = event({ notification: { close, data } });
      worker.listeners.get('notificationclick')?.(made);
      await Promise.all(waits);
      return close;
    };

    it('closes the notification and opens the page when no window of the app is open', async () => {
      const worker = load([
        { url: 'https://other.example.net/', focus: vi.fn(), navigate: vi.fn() },
      ]);
      const close = await tap(worker, { url: '/signals/abc' });
      expect(close).toHaveBeenCalledOnce();
      // a window of the app that this worker does not control yet is found too
      expect(worker.self.clients.matchAll).toHaveBeenCalledExactlyOnceWith({
        type: 'window',
        includeUncontrolled: true,
      });
      expect(worker.opened).toEqual([`${ORIGIN}/signals/abc`]);
    });

    it('takes the window that is open to the page, and opens no other', async () => {
      const focused = { url: `${ORIGIN}/news`, navigate: vi.fn(() => Promise.resolve({})) };
      const open: FakeClient = {
        url: `${ORIGIN}/news`,
        focus: vi.fn(() => Promise.resolve(focused)),
        navigate: vi.fn(),
      };
      const worker = load([open]);
      await tap(worker, { url: '/signals/abc' });
      expect(open.focus).toHaveBeenCalledOnce();
      expect(focused.navigate).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/signals/abc`);
      expect(worker.opened).toEqual([]);
    });

    it('opens a new window when the open one cannot be taken to the page', async () => {
      const refusing: FakeClient = {
        url: `${ORIGIN}/`,
        focus: vi.fn(() =>
          Promise.resolve({ url: `${ORIGIN}/`, navigate: () => Promise.resolve(null) }),
        ),
        navigate: vi.fn(),
      };
      const worker = load([refusing]);
      await tap(worker, { url: '/signals/abc' });
      expect(worker.opened).toEqual([`${ORIGIN}/signals/abc`]);

      const failing: FakeClient = {
        url: `${ORIGIN}/`,
        focus: vi.fn(() => Promise.reject(new Error('no'))),
        navigate: vi.fn(),
      };
      const second = load([failing]);
      await tap(second, { url: '/signals/abc' });
      expect(second.opened).toEqual([`${ORIGIN}/signals/abc`]);
    });

    it('opens the front page for a notification that carries no page, and never an address of another site', async () => {
      for (const data of [undefined, null, {}, { url: 7 }, { url: 'https://evil.example.net/' }]) {
        const worker = load();
        await tap(worker, data);
        expect(worker.opened, JSON.stringify(data)).toEqual([`${ORIGIN}/`]);
      }
    });
  });
});
