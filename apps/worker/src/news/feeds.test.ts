import { readFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeFeeds } from '../testing/fakeFeeds';
import { DEFAULT_FEEDS, HeadlineFeedClient, type FeedSource } from './feeds';
import { FeedError } from './parsers';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 25, 11, 0, 0);
const NO_VALIDATORS = { etag: null, lastModified: null } as const;

describe('DEFAULT_FEEDS', () => {
  it('has the Federal Reserve as the official source, three outlets and Biquote as an aggregator', () => {
    expect(DEFAULT_FEEDS.map((feed) => [feed.key, feed.tier, feed.kind])).toEqual([
      ['fed_press', 1, 'rss'],
      ['bbc_world', 2, 'rss'],
      ['aljazeera', 2, 'rss'],
      ['cnbc_top', 2, 'rss'],
      ['biquote_news', 3, 'biquote'],
    ]);
    for (const feed of DEFAULT_FEEDS) expect(feed.url.startsWith('https://')).toBe(true);
    expect(new Set(DEFAULT_FEEDS.map((feed) => feed.key)).size).toBe(DEFAULT_FEEDS.length);
  });
});

describe('HeadlineFeedClient', () => {
  const fake = new FakeFeeds();
  let client: HeadlineFeedClient;

  const source = (path: string, change: Partial<FeedSource> = {}): FeedSource => ({
    key: 'test',
    name: 'Test feed',
    tier: 2,
    kind: 'rss',
    url: fake.url(path),
    ...change,
  });

  beforeAll(async () => {
    await fake.start();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.requests.length = 0;
    fake.cancelled = 0;
    client = new HeadlineFeedClient({ timeoutMs: 400, maxBytes: 100_000, now: () => NOW });
  });
  afterEach(() => {
    fake.set('/feed', { body: '' });
  });

  it('reads a feed and gives its headlines and what the server said about the copy', async () => {
    fake.set('/feed', {
      body: fixture('fed-press.xml'),
      contentType: 'text/xml',
      etag: 'W/"abc"',
      lastModified: 'Fri, 16 Oct 2026 15:00:18 GMT',
    });
    const reading = await client.read(source('/feed'), NO_VALIDATORS);
    expect(reading.status).toBe('ok');
    expect(reading.items).toHaveLength(3);
    expect(reading.skipped).toBe(0);
    expect(reading.validators).toEqual({
      etag: 'W/"abc"',
      lastModified: 'Fri, 16 Oct 2026 15:00:18 GMT',
    });
  });

  it('introduces itself and says what it accepts, and sends no condition the first time', async () => {
    fake.set('/feed', { body: fixture('bbc-world.xml') });
    await client.read(source('/feed'), NO_VALIDATORS);
    const [request] = fake.requestsTo('/feed');
    expect(String(request?.headers['user-agent'])).toContain('vm-gold-signal');
    expect(String(request?.headers.accept)).toContain('application/rss+xml');
    expect(request?.headers['if-none-match']).toBeUndefined();
    expect(request?.headers['if-modified-since']).toBeUndefined();
  });

  it('asks whether the feed has changed, and takes a 304 as a good reading with nothing new', async () => {
    fake.set('/feed', {
      body: fixture('fed-press.xml'),
      etag: 'W/"abc"',
      lastModified: 'Fri, 16 Oct 2026 15:00:18 GMT',
    });
    const first = await client.read(source('/feed'), NO_VALIDATORS);
    const second = await client.read(source('/feed'), first.validators);
    expect(second).toEqual({
      status: 'not_modified',
      items: [],
      skipped: 0,
      validators: first.validators,
    });
    const [, asked] = fake.requestsTo('/feed');
    expect(asked?.headers['if-none-match']).toBe('W/"abc"');
    expect(asked?.headers['if-modified-since']).toBe('Fri, 16 Oct 2026 15:00:18 GMT');
    // the feed changed: the old validators no longer match and the whole feed comes
    fake.set('/feed', { body: fixture('fed-press.xml'), etag: 'W/"def"' });
    const third = await client.read(source('/feed'), { etag: 'W/"abc"', lastModified: null });
    expect(third.status).toBe('ok');
    expect(third.validators.etag).toBe('W/"def"');
  });

  it('is not fooled by a server that has an ETag but sends the whole feed anyway', async () => {
    fake.set('/feed', { body: fixture('aljazeera.xml'), etag: 'W/"x"', ignoreConditions: true });
    const first = await client.read(source('/feed'), NO_VALIDATORS);
    const again = await client.read(source('/feed'), first.validators);
    expect(again.status).toBe('ok');
    expect(again.items).toHaveLength(3);
  });

  it('reads a feed without validators (BBC and CNBC send none), and a gzip answer', async () => {
    fake.set('/plain', { body: fixture('cnbc.xml') });
    const plain = await client.read(source('/plain'), NO_VALIDATORS);
    expect(plain.validators).toEqual(NO_VALIDATORS);
    expect(plain.items).toHaveLength(3);
    fake.set('/zipped', { body: fixture('bbc-world.xml'), gzip: true });
    expect((await client.read(source('/zipped'), NO_VALIDATORS)).items).toHaveLength(3);
  });

  it('reads the Biquote news as JSON, with the right Accept header', async () => {
    fake.set('/api/News/market?symbol=XAUUSD', {
      body: fixture('biquote-gold.json'),
      contentType: 'application/json',
    });
    const reading = await client.read(
      source('/api/News/market?symbol=XAUUSD', { kind: 'biquote', tier: 3 }),
      NO_VALIDATORS,
    );
    expect(reading.items).toHaveLength(4);
    expect(String(fake.requests[0]?.headers.accept)).toBe('application/json');
  });

  it('fails with the status on an HTTP error, and with a message that has no address in it', async () => {
    fake.next('/feed', { type: 'status', status: 503 });
    const error = await client
      .read(source('/feed'), NO_VALIDATORS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeedError);
    expect(error).toMatchObject({ kind: 'http', status: 503, message: 'Test feed answered 503' });
    await expect(client.read(source('/missing'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });

  it('fails when the feed takes too long, and when the connection is cut or nothing listens', async () => {
    fake.next('/feed', { type: 'hang' });
    await expect(client.read(source('/feed'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'timeout',
    });
    fake.next('/feed', { type: 'drop' });
    await expect(client.read(source('/feed'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'network',
    });
    const lost = source('/feed', { url: 'http://127.0.0.1:1/secret?token=abc' });
    const error = await client.read(lost, NO_VALIDATORS).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'network', message: 'Test feed could not be reached' });
    expect((error as Error).message).not.toContain('token');
  });

  it('refuses a feed that is too big: by its declared size, and by what it actually sends', async () => {
    fake.set('/feed', { body: fixture('bbc-world.xml') });
    fake.next('/feed', { type: 'declared', bytes: 200_000 });
    await expect(client.read(source('/feed'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'too_large',
    });
    fake.next('/feed', { type: 'endless' });
    await expect(client.read(source('/feed'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'too_large',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.cancelled).toBe(1);
  });

  it('fails with a format error for a page that is not a feed, and for JSON that is not JSON', async () => {
    fake.set('/page', { body: '<html><body>maintenance</body></html>', contentType: 'text/html' });
    await expect(client.read(source('/page'), NO_VALIDATORS)).rejects.toMatchObject({
      kind: 'format',
    });
    fake.set('/json', { body: '<html>', contentType: 'application/json' });
    await expect(
      client.read(source('/json', { kind: 'biquote', tier: 3 }), NO_VALIDATORS),
    ).rejects.toMatchObject({ kind: 'format', message: 'Test feed did not answer with JSON' });
    fake.set('/object', { body: '{"error":"x"}', contentType: 'application/json' });
    await expect(
      client.read(source('/object', { kind: 'biquote', tier: 3 }), NO_VALIDATORS),
    ).rejects.toMatchObject({ kind: 'format' });
  });
});
