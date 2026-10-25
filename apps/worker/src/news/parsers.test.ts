import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FUTURE_TOLERANCE_MS,
  FeedError,
  canonicalUrl,
  parseBiquoteNews,
  parseFeed,
  safeUrl,
} from './parsers';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** After the newest item of the recorded feeds. */
const NOW = Date.UTC(2026, 9, 25, 11, 0, 0);

describe('parseFeed on the recorded feeds', () => {
  it('reads BBC News: CDATA titles, links with `&amp;` in the query, RFC 822 times', () => {
    const { items, skipped } = parseFeed(fixture('bbc-world.xml'), NOW);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title:
        'More than 1,300 arrested as clashes follow another day of mass protests across France',
      url: 'https://www.bbc.co.uk/news/articles/c95ynd587ynzo?at_medium=RSS&at_campaign=rss',
      summary:
        'Hundreds of thousands took part in demonstrations in France, with protests also taking place in other European countries.',
      publishedAt: Date.UTC(2026, 9, 25, 10, 38, 15),
    });
    expect(items[2]?.title).toBe(
      "Musk says SpaceX restricted Ukraine's Starlink connection as service restored",
    );
  });

  it('reads Al Jazeera: plain titles, a `+0000` zone, and elements of other namespaces it does not need', () => {
    const { items } = parseFeed(fixture('aljazeera.xml'), NOW);
    expect(items.map((item) => item.title)).toEqual([
      'Qatar official calls for peace and security to boost trade, investment',
      'Israeli forces turn Hebron homes into military posts amid lockdown',
      'Australian Grand Prix called off as rain spoils Phillip Island sendoff',
    ]);
    expect(items[0]?.url).toBe(
      'https://www.aljazeera.com/news/2026/10/25/qatar-official-calls-for-peace-and-security-to-boost-trade-investment?traffic_source=rss',
    );
    expect(items[0]?.publishedAt).toBe(Date.UTC(2026, 9, 25, 9, 57, 40));
  });

  it('reads CNBC: a time without seconds, and `&apos;` in a title', () => {
    const { items } = parseFeed(fixture('cnbc.xml'), NOW);
    expect(items).toHaveLength(3);
    expect(items[1]?.title).toBe(
      "Democrats, voting-rights groups challenge Trump's bid to block Alaska Senate certification",
    );
    expect(items[0]?.publishedAt).toBe(Date.UTC(2026, 9, 24, 14, 30, 1));
  });

  it('reads the Federal Reserve: `&#39;` decoded, a curly quote kept, a link in CDATA', () => {
    const { items } = parseFeed(fixture('fed-press.xml'), NOW);
    expect(items[1]?.title).toBe(
      "Minutes of the Board's discount rate meetings on August 17, September 9, and September 16, 2026",
    );
    expect(items[1]?.url).toBe(
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261013a.htm',
    );
    expect(items[2]?.title).toContain('the firm\u2019s failure');
    expect(items[1]?.publishedAt).toBe(Date.UTC(2026, 9, 13, 18, 0, 0));
  });

  it('keeps a summary of at most 300 characters, and none where the feed has none', () => {
    for (const name of ['bbc-world.xml', 'aljazeera.xml', 'cnbc.xml', 'fed-press.xml']) {
      for (const item of parseFeed(fixture(name), NOW).items) {
        expect(item.summary === null || item.summary.length <= 300).toBe(true);
      }
    }
    const long = `<rss><channel><item><title>T</title><link>https://a.example/x</link><description>${'w '.repeat(300)}</description></item></channel></rss>`;
    expect(parseFeed(long, NOW).items[0]?.summary).toHaveLength(300);
    const none =
      '<rss><channel><item><title>T</title><link>https://a.example/x</link></item></channel></rss>';
    expect(parseFeed(none, NOW).items[0]).toEqual({
      title: 'T',
      url: 'https://a.example/x',
      summary: null,
      publishedAt: null,
    });
  });
});

describe('parseFeed, other shapes', () => {
  it('reads Atom: the alternate link, `published` before `updated`, a summary', () => {
    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title type="html">Fed &amp;amp; Powell</title>
          <link rel="self" href="https://a.example/self"/>
          <link rel="alternate" href="https://a.example/story?id=1&amp;x=2"/>
          <updated>2026-10-25T10:00:00Z</updated>
          <published>2026-10-25T09:00:00Z</published>
          <summary>Short summary</summary>
        </entry>
      </feed>`;
    expect(parseFeed(atom, NOW).items).toEqual([
      {
        title: 'Fed & Powell',
        url: 'https://a.example/story?id=1&x=2',
        summary: 'Short summary',
        publishedAt: Date.UTC(2026, 9, 25, 9, 0, 0),
      },
    ]);
  });

  it('reads RSS 1.0, where the items are beside the channel, with a Dublin Core date', () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>x</title></channel>
        <item><title>Story</title><link>https://a.example/s</link><dc:date>2026-10-25T08:00:00Z</dc:date></item>
      </rdf:RDF>`;
    expect(parseFeed(rdf, NOW).items).toEqual([
      {
        title: 'Story',
        url: 'https://a.example/s',
        summary: null,
        publishedAt: Date.UTC(2026, 9, 25, 8, 0, 0),
      },
    ]);
  });

  it('uses the guid as the link when the item has no link and the guid is one', () => {
    const xml =
      '<rss><channel><item><title>T</title><guid>https://a.example/g</guid></item><item><title>U</title><guid>not-a-link</guid></item></channel></rss>';
    const { items, skipped } = parseFeed(xml, NOW);
    expect(items.map((item) => item.url)).toEqual(['https://a.example/g']);
    expect(skipped).toBe(1);
  });

  it('is an empty list for a feed with no item, and a single item is a list of one', () => {
    expect(parseFeed('<rss><channel><title>x</title></channel></rss>', NOW)).toEqual({
      items: [],
      skipped: 0,
    });
    const one =
      '<rss><channel><item><title>T</title><link>https://a.example/1</link></item></channel></rss>';
    expect(parseFeed(one, NOW).items).toHaveLength(1);
  });

  it('skips and counts an item without a title or a usable link, and a link that is not http', () => {
    const xml = `<rss><channel>
      <item><title>No link</title></item>
      <item><link>https://a.example/no-title</link></item>
      <item><title>Script</title><link>javascript:alert(1)</link></item>
      <item><title>File</title><link>file:///etc/passwd</link></item>
      <item><title>Good</title><link>https://a.example/good</link></item>
    </channel></rss>`;
    const { items, skipped } = parseFeed(xml, NOW);
    expect(items.map((item) => item.title)).toEqual(['Good']);
    expect(skipped).toBe(4);
  });

  it('cleans a title: entities twice encoded, tags, a mojibake, invisible characters', () => {
    const xml = `<rss><channel><item>
      <title>Fed &amp;amp; &lt;b&gt;Powell&lt;/b&gt;\u200B says \u00E2\u20AC\u201C no</title>
      <link>https://a.example/c</link>
    </item></channel></rss>`;
    expect(parseFeed(xml, NOW).items[0]?.title).toBe('Fed & Powell says \u2013 no');
  });

  it('ignores a published time that cannot be right: none, unreadable, or more than 10 minutes ahead', () => {
    expect(FUTURE_TOLERANCE_MS).toBe(10 * 60_000);
    const at = (pubDate: string) =>
      parseFeed(
        `<rss><channel><item><title>T</title><link>https://a.example/t</link><pubDate>${pubDate}</pubDate></item></channel></rss>`,
        NOW,
      ).items[0]?.publishedAt;
    expect(at('Sun, 25 Oct 2026 11:10:00 GMT')).toBe(NOW + 10 * 60_000);
    expect(at('Sun, 25 Oct 2026 11:10:01 GMT')).toBeNull();
    expect(at('yesterday')).toBeNull();
    expect(at('')).toBeNull();
  });

  it('takes a byte order mark in front of the document', () => {
    const xml = `\uFEFF<rss><channel><item><title>T</title><link>https://a.example/t</link></item></channel></rss>`;
    expect(parseFeed(xml, NOW).items).toHaveLength(1);
  });

  it('refuses what is not a feed: no XML, a page, an empty document, a feed that declares entities', () => {
    for (const bad of [
      '',
      'not xml at all',
      '<html><body>maintenance</body></html>',
      '<rss',
      '<a/>',
    ]) {
      expect(() => parseFeed(bad, NOW), bad).toThrow(FeedError);
    }
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><rss><channel><item><title>&lol2;</title><link>https://a.example/t</link></item></channel></rss>`;
    expect(() => parseFeed(bomb, NOW)).toThrow('the feed declares its own entities');
    try {
      parseFeed('<html/>', NOW);
    } catch (error) {
      expect(error).toMatchObject({ kind: 'format' });
    }
  });
});

describe('parseBiquoteNews on the recorded answer', () => {
  const body = JSON.parse(fixture('biquote-gold.json')) as unknown;

  it('reads title, link and time, repairs the mojibake, and keeps no summary', () => {
    const { items, skipped } = parseBiquoteNews(body, NOW);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      title:
        'Trump announces at a Georgia campaign rally that Audi will build a new auto factory in the state',
      url: 'https://news.google.com/rss/articles/CBMipgFBVV95cUxPRTFJejhGVHpHM3RQVWQ4UzVmaWJf?oc=5',
      summary: null,
      publishedAt: Date.UTC(2026, 9, 25, 2, 22, 0),
    });
    expect(items[1]?.title).toBe(
      'Americans have never had more of their money in stocks \u2014 not even in the dot-com bubble: Chart of the Day',
    );
  });

  it('skips a row without a title or a link, and is a failure when nothing can be read or it is not a list', () => {
    expect(
      parseBiquoteNews(
        [
          { title: 'ok', url: 'https://a.example/1' },
          { title: '', url: 'https://a.example/2' },
          5,
          { title: 'x', url: 'ftp://a' },
        ],
        NOW,
      ),
    ).toEqual({
      items: [{ title: 'ok', url: 'https://a.example/1', summary: null, publishedAt: null }],
      skipped: 3,
    });
    expect(parseBiquoteNews([], NOW)).toEqual({ items: [], skipped: 0 });
    expect(() => parseBiquoteNews([{ nope: true }, 3], NOW)).toThrow(FeedError);
    expect(() => parseBiquoteNews({ error: 'x' }, NOW)).toThrow('did not return a list');
    expect(() => parseBiquoteNews(null, NOW)).toThrow(FeedError);
  });
});

describe('safeUrl and canonicalUrl', () => {
  it('accepts http and https links only, of at most 2048 characters', () => {
    expect(safeUrl(' https://a.example/x ')).toBe('https://a.example/x');
    expect(safeUrl('http://a.example/')).toBe('http://a.example/');
    for (const bad of [
      '',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.example',
      '/relative',
      'a b',
    ]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
    expect(safeUrl(`https://a.example/${'x'.repeat(2030)}`)).not.toBeNull();
    expect(safeUrl(`https://a.example/${'x'.repeat(2040)}`)).toBeNull();
  });

  it('drops what only says where the reader came from, so that two links to one story are one', () => {
    expect(
      canonicalUrl(
        'https://WWW.BBC.co.uk/news/articles/c95?at_medium=RSS&at_campaign=rss&id=7#frag',
      ),
    ).toBe('https://www.bbc.co.uk/news/articles/c95?id=7');
    expect(canonicalUrl('https://www.aljazeera.com/news/x?traffic_source=rss')).toBe(
      'https://www.aljazeera.com/news/x',
    );
    expect(canonicalUrl('https://a.example/?utm_source=x&utm_medium=y')).toBe('https://a.example');
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});
