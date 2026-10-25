import type { SourceTier } from '@vmgs/core';

import { FeedError, parseBiquoteNews, parseFeed, type ParsedFeed } from './parsers';

export type FeedKind = 'rss' | 'biquote';

/** A headline feed: its key in `news_sources`, how it is read and how far it is trusted. */
export interface FeedSource {
  readonly key: string;
  readonly name: string;
  readonly tier: SourceTier;
  readonly kind: FeedKind;
  readonly url: string;
}

/**
 * The feeds of 01_HLD section 3 and 02 section 16: the Federal Reserve (official), three major
 * outlets, and the Biquote news service as an extra, tier 3 source (an aggregator). Title and link
 * only are kept. A feed is switched off in `news_sources.enabled`; a feed that is not in this list
 * needs a change here.
 */
export const DEFAULT_FEEDS: readonly FeedSource[] = [
  {
    key: 'fed_press',
    name: 'Federal Reserve',
    tier: 1,
    kind: 'rss',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
  },
  {
    key: 'bbc_world',
    name: 'BBC News',
    tier: 2,
    kind: 'rss',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  },
  {
    key: 'aljazeera',
    name: 'Al Jazeera',
    tier: 2,
    kind: 'rss',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
  },
  {
    key: 'cnbc_top',
    name: 'CNBC',
    tier: 2,
    kind: 'rss',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  },
  {
    key: 'biquote_news',
    name: 'Biquote news',
    tier: 3,
    kind: 'biquote',
    url: 'https://biquote.io/api/News/market?symbol=XAUUSD&maxResults=40',
  },
];

/** What the server said about the copy that was read, to ask "has it changed" next time. */
export interface Validators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FeedReading {
  readonly status: 'ok' | 'not_modified';
  readonly items: ParsedFeed['items'];
  readonly skipped: number;
  readonly validators: Validators;
}

export interface HeadlineFeedClientOptions {
  readonly fetch?: typeof fetch;
  /** 02 section 16: a 20 s timeout. */
  readonly timeoutMs?: number;
  /** A feed bigger than this is refused (the biggest of the four feeds is about 25 KB). */
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const USER_AGENT = 'vm-gold-signal/0.1 (private research tool; headline and link only)';

/** Reads the body of a response up to `maxBytes`: a stream that goes on longer is cut and refused. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FeedError(`the feed is larger than ${String(maxBytes)} bytes`, 'too_large');
  }
  if (response.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FeedError(`the feed is larger than ${String(maxBytes)} bytes`, 'too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Reads one feed over HTTP on the native `fetch`: conditional requests when the server gave an ETag or a
 * Last-Modified, a timeout, a size limit, and errors that say what happened without a secret in them.
 */
export class HeadlineFeedClient {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: HeadlineFeedClientOptions = {}) {
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBytes = options.maxBytes ?? 2_000_000;
    this.now = options.now ?? Date.now;
  }

  async read(source: FeedSource, validators: Validators): Promise<FeedReading> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept:
        source.kind === 'rss'
          ? 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5'
          : 'application/json',
    };
    if (validators.etag !== null) headers['if-none-match'] = validators.etag;
    if (validators.lastModified !== null) headers['if-modified-since'] = validators.lastModified;

    let response: Response;
    try {
      response = await this.doFetch(source.url, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new FeedError(
          `${source.name} did not answer in ${String(this.timeoutMs)} ms`,
          'timeout',
        );
      }
      throw new FeedError(`${source.name} could not be reached`, 'network');
    }
    const next: Validators = {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 'not_modified', items: [], skipped: 0, validators };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FeedError(
        `${source.name} answered ${String(response.status)}`,
        'http',
        response.status,
      );
    }

    let text: string;
    try {
      text = await readLimited(response, this.maxBytes);
    } catch (error) {
      if (error instanceof FeedError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new FeedError(
        name === 'TimeoutError' || name === 'AbortError'
          ? `${source.name} stopped answering`
          : `${source.name} could not be read to the end`,
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      );
    }
    const parsed =
      source.kind === 'rss'
        ? parseFeed(text, this.now())
        : parseBiquoteNews(this.json(text, source), this.now());
    return { status: 'ok', items: parsed.items, skipped: parsed.skipped, validators: next };
  }

  private json(text: string, source: FeedSource): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FeedError(`${source.name} did not answer with JSON`, 'format');
    }
  }
}
