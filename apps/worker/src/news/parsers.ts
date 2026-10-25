import { XMLParser } from 'fast-xml-parser';
import { cleanHeadline, cleanSummary } from '@vmgs/core';

/** A headline as a feed gives it, cleaned (times in epoch milliseconds). */
export interface RawHeadline {
  readonly title: string;
  readonly url: string;
  readonly summary: string | null;
  /** The published time; null when the feed gave none, or one that cannot be right. */
  readonly publishedAt: number | null;
}

export interface ParsedFeed {
  readonly items: RawHeadline[];
  /** Entries without a title or a usable link: not kept. */
  readonly skipped: number;
}

export type FeedErrorKind = 'http' | 'network' | 'timeout' | 'format' | 'too_large';

/** A reading of a feed that failed. The poller backs off for that feed only. Its text never holds more than the status. */
export class FeedError extends Error {
  constructor(
    message: string,
    readonly kind: FeedErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

/** A published time this far in the future is a feed with a wrong clock: it is ignored. */
export const FUTURE_TOLERANCE_MS = 10 * 60_000;
const MAX_URL_LENGTH = 2048;

/** The link of an item: http or https, at most 2048 characters; null otherwise (a `javascript:` link never gets in). */
export function safeUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || text.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

const TRACKING =
  /^(utm_.*|at_medium|at_campaign|at_custom\d|traffic_source|ocid|cmpid|ito|ref|source)$/i;

/** The address without what only says where a reader came from, so that two links to one story are one. */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    const text = parsed.toString();
    return text.endsWith('/') && parsed.pathname === '/' ? text.slice(0, -1) : text;
  } catch {
    return url;
  }
}

function timeOf(text: string | null, now: number): number | null {
  if (text === null) return null;
  const time = Date.parse(text);
  if (!Number.isFinite(time) || time > now + FUTURE_TOLERANCE_MS) return null;
  return time;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a node: a string, or the text node of an element that has attributes. */
function textOf(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (isRecord(node) && typeof node['#text'] === 'string') return node['#text'];
  return null;
}

function firstText(...nodes: unknown[]): string | null {
  for (const node of nodes) {
    const list: unknown[] = Array.isArray(node) ? (node as unknown[]) : [node];
    for (const entry of list) {
      const text = textOf(entry);
      if (text !== null && text.trim() !== '') return text;
    }
  }
  return null;
}

/** The address of an item: the text of `<link>`, or the `href` of an Atom link (the alternate one first). */
function linkOf(item: Record<string, unknown>): string | null {
  const links: unknown[] = Array.isArray(item.link) ? (item.link as unknown[]) : [item.link];
  const candidates: { href: string; alternate: boolean }[] = [];
  for (const link of links) {
    const text = textOf(link);
    if (isRecord(link) && typeof link['@_href'] === 'string') {
      const rel = typeof link['@_rel'] === 'string' ? link['@_rel'] : 'alternate';
      candidates.push({ href: link['@_href'], alternate: rel === 'alternate' });
    } else if (text !== null && text.trim() !== '') {
      candidates.push({ href: text, alternate: true });
    }
  }
  for (const candidate of candidates.filter((c) => c.alternate)) {
    const url = safeUrl(decodeAmp(candidate.href));
    if (url !== null) return url;
  }
  // an RSS item with no link may have a guid that is a link
  const guid = textOf(item.guid);
  return guid === null ? null : safeUrl(guid);
}

// A link in an attribute is already decoded by the parser; one that still has `&amp;` was encoded twice.
const decodeAmp = (text: string): string => text.replaceAll('&amp;', '&');

function make(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    removeNSPrefix: true,
    // `&#39;` and the like are decoded by the parser, as 01_HLD asks; `cleanHeadline` decodes what is left.
    htmlEntities: true,
    isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
  });
}

const parser = make();

/**
 * Reads an RSS 2.0, RSS 1.0 or Atom feed into headlines: the title and the link, a summary of at most
 * 300 characters, and the published time. A feed that declares entities of its own (a trick to make the
 * parser blow up) is refused; an item without a title or a usable link is skipped and counted.
 */
export function parseFeed(xml: string, now: number): ParsedFeed {
  if (/<!ENTITY/i.test(xml)) throw new FeedError('the feed declares its own entities', 'format');
  let document: unknown;
  try {
    document = parser.parse(xml.replace(/^\uFEFF/, ''));
  } catch {
    throw new FeedError('the feed is not valid XML', 'format');
  }
  if (!isRecord(document)) throw new FeedError('the feed is empty', 'format');
  const root = document.rss ?? document.feed ?? document.RDF;
  if (!isRecord(root)) throw new FeedError('the feed is not RSS or Atom', 'format');
  const channel = isRecord(root.channel) ? root.channel : root;
  const entries = (channel.item ?? channel.entry ?? root.item ?? []) as unknown[];

  const items: RawHeadline[] = [];
  let skipped = 0;
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const title = cleanHeadline(firstText(entry.title) ?? '');
    const url = linkOf(entry);
    if (title === '' || url === null) {
      skipped += 1;
      continue;
    }
    items.push({
      title,
      url,
      summary: cleanSummary(firstText(entry.description, entry.summary)),
      publishedAt: timeOf(
        firstText(entry.pubDate, entry.published, entry.updated, entry.date),
        now,
      ),
    });
  }
  return { items, skipped };
}

/**
 * Reads the answer of Biquote's `/api/News/market`: a list of `{title, url, publisher, publishedDate}`.
 * Its `description` is a run of other outlets' titles and is not kept. Anything that is not a list is a
 * failure; a row without a title or a link is skipped.
 */
export function parseBiquoteNews(body: unknown, now: number): ParsedFeed {
  if (!Array.isArray(body)) throw new FeedError('the news service did not return a list', 'format');
  const items: RawHeadline[] = [];
  let skipped = 0;
  for (const row of body as unknown[]) {
    if (!isRecord(row)) {
      skipped += 1;
      continue;
    }
    const title = typeof row.title === 'string' ? cleanHeadline(row.title) : '';
    const url = typeof row.url === 'string' ? safeUrl(row.url) : null;
    if (title === '' || url === null) {
      skipped += 1;
      continue;
    }
    items.push({
      title,
      url,
      summary: null,
      publishedAt: timeOf(typeof row.publishedDate === 'string' ? row.publishedDate : null, now),
    });
  }
  if (body.length > 0 && items.length === 0) {
    throw new FeedError('no row of the news service could be read', 'format');
  }
  return { items, skipped };
}
