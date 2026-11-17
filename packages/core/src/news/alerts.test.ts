import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../domain';
import type { AlertSettings } from '../lifecycle/alerts';
import { checkTelegramHtml } from '../messages/markup';
import { ICON } from '../messages/style';
import { plain } from '../messages/test-html';
import type { DisplayOptions } from '../messages/types';
import {
  NEWS_ALERT_TTL_MS,
  TOPIC_HISTORY_MIN_N,
  headlineAlertDue,
  headlineEventKey,
  headlineFeedsBackMessage,
  headlineFeedsDownMessage,
  headlineHealthEventKey,
  headlineTold,
  impactAtLeast,
  marketMoveMessage,
  marketMoveRows,
  moveEventKey,
  newsHeadlineMessage,
  newsHeadlineRows,
  type HeadlineAlertData,
  type MarketMoveData,
} from './alerts';
import { frozenHeadline, frozenUnclassified, type HeadlineCluster } from './context';
import { NEWS_ALERTS, topicSwitches } from './test-data';

const EN: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HI: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
/** 2026-10-23 16:14 UTC is 21:44 IST. */
const T = Date.UTC(2026, 9, 23, 16, 14, 0);
const MIN = 60_000;

const CLUSTER: HeadlineCluster = {
  id: 'cl-1',
  title: 'Trump announces new tariffs on European goods',
  url: 'https://www.bbc.co.uk/news/articles/c95ynd587',
  sources: [
    { key: 'bbc', name: 'BBC News' },
    { key: 'cnbc', name: 'CNBC' },
  ],
  topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
  impact: 'HIGH',
  publishedAt: T - 2 * MIN,
  firstSeenAt: T - MIN,
};

const HEADLINE: HeadlineAlertData = {
  cluster: CLUSTER,
  detectedAt: T,
  since: { usd: 3.8, atr: 0.9, spread: 0.21 },
  history: { topic: 'TRUMP_POLICY', impact: 'HIGH', n: 52, share: 0.38, baseline: 0.14 },
};

const SETTINGS: AlertSettings = {
  displayTz: 'Asia/Kolkata',
  locale: 'en',
  alerts: {
    telegram: { enabled: true, minGrade: 'Moderate', kinds: [...NOTIFICATION_KINDS] },
    webpush: { enabled: true, minGrade: 'Moderate' },
  },
  strategyAlerts: {
    trend_pullback: 'on',
    sweep_reversal: 'on',
    squeeze_retest: 'on',
    trendline_retest: 'off',
    pattern_breakout: 'off',
    hourly_trend: 'off',
  },
  newsAlerts: NEWS_ALERTS,
};

describe('NEWS_HEADLINE', () => {
  it('says the headline, where it ran, how late it was seen, what gold did, what the topic has done before', () => {
    const message = newsHeadlineMessage(HEADLINE, EN);
    expect(message.kind).toBe('NEWS_HEADLINE');
    expect(message.telegram.text).toBe(
      [
        `${ICON.news} <b>HEADLINE (HIGH) | Trump policy, Geopolitics</b>`,
        '"Trump announces new tariffs on European goods"',
        'Seen in: BBC News, CNBC. Published 21:42 IST, detected 21:44 IST (2 min later).',
        'Gold since publication: +3.800 USD (0.9 x ATR 5m), spread 0.210.',
        'Topic history: HIGH Trump policy headlines moved gold by 1 ATR or more in 38% of cases (n=52, normal 14%).',
        'Link: https://www.bbc.co.uk/news/articles/c95ynd587',
        'This is context, not a signal. Whether the headline caused the move is not known.',
      ].join('\n'),
    );
    expect(message.push).toEqual({
      title: 'HEADLINE (HIGH): Trump policy',
      body: 'Trump announces new tariffs on European goods',
      urgency: 'normal',
      url: '/news?tab=headlines',
    });
  });

  it('is written in Hinglish too, with the same numbers', () => {
    expect(plain(newsHeadlineMessage(HEADLINE, HI).telegram.text)).toBe(
      [
        `${ICON.news} HEADLINE (HIGH) | Trump policy, Geopolitics`,
        '"Trump announces new tariffs on European goods"',
        'Dikhi: BBC News, CNBC. Published 21:42 IST, detect hui 21:44 IST (2 min baad).',
        'Publication ke baad gold: +3.800 USD (0.9 x ATR 5m), spread 0.210.',
        'Topic ka record: HIGH Trump policy headlines ke baad gold 38% baar 1 ATR ya zyada hila (n=52, normal 14%).',
        'Link: https://www.bbc.co.uk/news/articles/c95ynd587',
        'Ye context hai, signal nahi. Headline se move hua ya nahi, ye pata nahi.',
      ].join('\n'),
    );
  });

  it('says what could not be measured: no tick, no ATR, no spread', () => {
    const none = plain(newsHeadlineMessage({ ...HEADLINE, since: null }, EN).telegram.text);
    expect(none).toContain('Gold since publication: not measured (no recent tick).');
    const noAtr = plain(
      newsHeadlineMessage({ ...HEADLINE, since: { usd: -2.5, atr: null, spread: null } }, EN)
        .telegram.text,
    );
    expect(noAtr).toContain('Gold since publication: -2.500 USD.');
  });

  it('has a topic history only from 30 measured headlines, and without a baseline it has none', () => {
    expect(TOPIC_HISTORY_MIN_N).toBe(30);
    const at = (n: number, baseline: number | null = 0.14) =>
      plain(
        newsHeadlineMessage(
          {
            ...HEADLINE,
            history: { topic: 'FED_RATES', impact: 'MEDIUM', n, share: 0.5, baseline },
          },
          EN,
        ).telegram.text,
      );
    expect(at(29)).toContain('Topic history: not enough data yet.');
    expect(at(30)).toContain(
      'Topic history: MED Fed and rates headlines moved gold by 1 ATR or more in 50% of cases (n=30, normal 14%).',
    );
    expect(at(30, null)).toContain('in 50% of cases (n=30).');
    expect(plain(newsHeadlineMessage({ ...HEADLINE, history: null }, EN).telegram.text)).toContain(
      'Topic history: not enough data yet.',
    );
  });

  it('says so when the feed gave no publication time, and never shows a negative delay', () => {
    const noTime = plain(
      newsHeadlineMessage({ ...HEADLINE, cluster: { ...CLUSTER, publishedAt: null } }, EN).telegram
        .text,
    );
    expect(noTime).toContain(
      'Seen in: BBC News, CNBC. No publication time given, detected 21:44 IST.',
    );
    const future = plain(
      newsHeadlineMessage({ ...HEADLINE, cluster: { ...CLUSTER, publishedAt: T + 5 * MIN } }, EN)
        .telegram.text,
    );
    expect(future).toContain('Published 21:49 IST, detected 21:44 IST (0 s later).');
  });

  it('is valid Telegram HTML, and text from outside cannot add a tag', () => {
    const hostile = newsHeadlineMessage(
      {
        ...HEADLINE,
        cluster: {
          ...CLUSTER,
          title: 'Fed \uE001forged\uE002 <b>x</b> & "y"',
          sources: [{ key: 'x', name: 'Out<let>' }],
          url: 'https://example.com/?a=1&b=2',
        },
      },
      EN,
    );
    expect(checkTelegramHtml(hostile.telegram.text)).toBeNull();
    expect(hostile.telegram.text).toContain('"Fed forged &lt;b&gt;x&lt;/b&gt; &amp; "y""');
    expect(hostile.telegram.text).toContain('Seen in: Out&lt;let&gt;.');
    expect(hostile.telegram.text).toContain('Link: https://example.com/?a=1&amp;b=2');
    expect(hostile.telegram.text).not.toMatch(/[\uE000-\uE00F]/);
    expect(checkTelegramHtml(newsHeadlineMessage(HEADLINE, EN).telegram.text)).toBeNull();
    expect(checkTelegramHtml(newsHeadlineMessage(HEADLINE, HI).telegram.text)).toBeNull();
  });
});

describe('headlineAlertDue and headlineTold', () => {
  it('is for a story that is at most 30 minutes old, by its time or by when it was first seen', () => {
    const at = (published: number | null, firstSeen = T) =>
      headlineAlertDue({ ...CLUSTER, publishedAt: published, firstSeenAt: firstSeen }, T);
    expect(at(T - 30 * MIN)).toBe(true);
    expect(at(T - 30 * MIN - 1)).toBe(false);
    expect(at(T)).toBe(true);
    expect(at(T + 1)).toBe(false);
    expect(at(null, T - 30 * MIN)).toBe(true);
    expect(at(null, T - 31 * MIN)).toBe(false);
  });

  it('is for a story of at least the impact asked for, with at least one topic that is on', () => {
    const settings = (change: Partial<AlertSettings['newsAlerts']>): AlertSettings => ({
      ...SETTINGS,
      newsAlerts: { ...NEWS_ALERTS, ...change },
    });
    expect(headlineTold(SETTINGS, CLUSTER)).toBe(true);
    expect(headlineTold(SETTINGS, { ...CLUSTER, impact: 'MEDIUM' })).toBe(false);
    expect(headlineTold(settings({ minImpact: 'MEDIUM' }), { ...CLUSTER, impact: 'MEDIUM' })).toBe(
      true,
    );
    expect(headlineTold(settings({ minImpact: 'MEDIUM' }), { ...CLUSTER, impact: 'LOW' })).toBe(
      false,
    );
    expect(headlineTold(settings({ minImpact: 'LOW' }), { ...CLUSTER, impact: 'LOW' })).toBe(true);
    const muted = { ...topicSwitches('on'), TRUMP_POLICY: 'off' as const };
    expect(headlineTold(settings({ topics: muted }), CLUSTER)).toBe(true);
    expect(headlineTold(settings({ topics: { ...muted, GEOPOLITICS_WAR: 'off' } }), CLUSTER)).toBe(
      false,
    );
    expect(headlineTold(settings({ topics: topicSwitches('off') }), CLUSTER)).toBe(false);
  });

  it('compares impacts in order', () => {
    expect(impactAtLeast('HIGH', 'HIGH')).toBe(true);
    expect(impactAtLeast('MEDIUM', 'HIGH')).toBe(false);
    expect(impactAtLeast('HIGH', 'LOW')).toBe(true);
    expect(impactAtLeast('LOW', 'MEDIUM')).toBe(false);
  });
});

describe('the rows of NEWS_HEADLINE', () => {
  it('has one for each channel, with its own key, valid for 30 minutes, and the page to open', () => {
    expect(NEWS_ALERT_TTL_MS).toBe(30 * MIN);
    expect(headlineEventKey('cl-1')).toBe('news:cl-1:headline');
    const rows = newsHeadlineRows(HEADLINE, SETTINGS, T);
    expect(
      rows.map((row) => [row.channel, row.kind, row.eventKey, row.signalId, row.expiresAt]),
    ).toEqual([
      ['telegram', 'NEWS_HEADLINE', 'news:cl-1:headline', null, T + 30 * MIN],
      ['webpush', 'NEWS_HEADLINE', 'news:cl-1:headline', null, T + 30 * MIN],
    ]);
    expect(rows[1]?.payload).toMatchObject({
      url: '/news?tab=headlines',
      ttlSec: 1800,
      tag: 'news:cl-1:headline',
      title: 'HEADLINE (HIGH): Trump policy',
    });
  });

  it('is written in the language of the settings, and has none for a story that is not told', () => {
    const hinglish = newsHeadlineRows(HEADLINE, { ...SETTINGS, locale: 'hinglish' }, T);
    expect(String(hinglish[0]?.payload.text)).toContain('Dikhi: BBC News');
    expect(
      newsHeadlineRows({ ...HEADLINE, cluster: { ...CLUSTER, impact: 'LOW' } }, SETTINGS, T),
    ).toEqual([]);
  });
});

const DETECTION = {
  kind: 'SPIKE_UP',
  windowS: 240,
  moveUsd: 9.8,
  moveAtr: 2.8,
  basis: '5m',
  atr: 3.5,
  at: T + 3 * MIN,
} as const;

const CAUSES = [
  {
    headline: frozenHeadline({
      ...CLUSTER,
      id: 'm1',
      title: 'Missile strike reported near Kharkiv',
      sources: [{ key: 'bbc', name: 'BBC News' }],
      topics: ['GEOPOLITICS_WAR'],
    }),
    at: T - 13 * MIN,
  },
  {
    headline: frozenHeadline({
      ...CLUSTER,
      id: 'm2',
      title: 'Treasury yields fall as investors weigh data',
      sources: [{ key: 'cnbc', name: 'CNBC' }],
      topics: ['FED_RATES'],
      impact: 'MEDIUM',
    }),
    at: T - 4 * MIN,
  },
  {
    headline: frozenUnclassified({
      title: 'Local bakery wins a prize',
      url: 'https://example.com/b',
      sourceName: 'Al Jazeera',
      publishedAt: T,
      firstSeenAt: T,
    }),
    at: T,
  },
];

const MOVE: MarketMoveData = {
  detection: DETECTION,
  spread: 0.35,
  causes: CAUSES,
  feed: 'AVAILABLE',
  open: [{ seq: 46, side: 'BUY', unrealisedR: 1.4 }],
};

describe('MARKET_MOVE', () => {
  it('says the move, then the headlines that were around it as possible causes, and the open signals', () => {
    const message = marketMoveMessage(MOVE, EN);
    expect(message.kind).toBe('MARKET_MOVE');
    expect(message.telegram.text).toBe(
      [
        `${ICON.spikeUp} <b>GOLD SPIKE UP +9.800 USD in 4 min (2.8 x ATR 5m), spread 0.350 at 21:47 IST.</b>`,
        'Possible causes, not confirmed (headlines in the previous 30 min, by impact):',
        '1. HIGH  "Missile strike reported near Kharkiv" (BBC News, 21:31 IST)',
        '2. MED  "Treasury yields fall as investors weigh data" (CNBC, 21:40 IST)',
        '3. (unclassified, timing only) "Local bakery wins a prize" (Al Jazeera, 21:44 IST)',
        `Open signals: ${ICON.buy} #S-0046 BUY (+1.40R).`,
      ].join('\n'),
    );
    expect(message.push).toEqual({
      title: 'GOLD SPIKE UP +9.800 USD',
      body: '2.8 x ATR 5m in 4 min.',
      urgency: 'high',
      url: '/news?tab=moves',
    });
  });

  it('is written in Hinglish too', () => {
    expect(plain(marketMoveMessage(MOVE, HI).telegram.text)).toBe(
      [
        `${ICON.spikeUp} GOLD SPIKE UP +9.800 USD 4 min mein (2.8 x ATR 5m), spread 0.350, 21:47 IST par.`,
        'Possible causes, confirm nahi (pichhle 30 min ki headlines, impact ke hisaab se):',
        '1. HIGH  "Missile strike reported near Kharkiv" (BBC News, 21:31 IST)',
        '2. MED  "Treasury yields fall as investors weigh data" (CNBC, 21:40 IST)',
        '3. (unclassified, sirf timing) "Local bakery wins a prize" (Al Jazeera, 21:44 IST)',
        `Khule signals: ${ICON.buy} #S-0046 BUY (+1.40R).`,
      ].join('\n'),
    );
  });

  it('shows a fall as a fall, in red, with the move signed, and a 1-minute move by its own ATR', () => {
    const down = marketMoveMessage(
      {
        ...MOVE,
        detection: { ...DETECTION, kind: 'SPIKE_DOWN', basis: '1m', moveAtr: 3.4, windowS: 45 },
        causes: [],
        open: [],
      },
      EN,
    );
    expect(plain(down.telegram.text).split('\n')[0]).toBe(
      `${ICON.spikeDown} GOLD SPIKE DOWN -9.800 USD in 45 s (3.4 x ATR 1m), spread 0.350 at 21:47 IST.`,
    );
    expect(down.push.title).toBe('GOLD SPIKE DOWN -9.800 USD');
  });

  it('says plainly when no headline matched, and that the move may have no news behind it', () => {
    const text = plain(marketMoveMessage({ ...MOVE, causes: [], open: [] }, EN).telegram.text);
    expect(text).toContain(
      'No matching headline found in the free feeds. The move may be technical, flow-driven, or the news may not be in these feeds yet.',
    );
    expect(text).toContain('Open signals: none.');
    expect(text).not.toContain('Possible causes');
  });

  it('does not claim "no headline" while the headline feeds are down', () => {
    const text = plain(
      marketMoveMessage({ ...MOVE, causes: [], feed: 'UNAVAILABLE' }, EN).telegram.text,
    );
    expect(text).toContain(
      'The headline feeds are unavailable, so possible causes could not be checked.',
    );
    expect(text).not.toContain('No matching headline found');
  });

  it('leaves out the spread when it is not known, and the R of a signal without a price', () => {
    const text = plain(
      marketMoveMessage(
        { ...MOVE, spread: null, open: [{ seq: 7, side: 'SELL', unrealisedR: null }] },
        EN,
      ).telegram.text,
    );
    expect(text).toContain('(2.8 x ATR 5m) at 21:47 IST.');
    expect(text).toContain(`Open signals: ${ICON.sell} #S-0007 SELL.`);
  });

  it('lists several open signals', () => {
    const text = plain(
      marketMoveMessage(
        {
          ...MOVE,
          open: [
            { seq: 45, side: 'BUY', unrealisedR: -0.4 },
            { seq: 46, side: 'SELL', unrealisedR: 0.2 },
          ],
        },
        EN,
      ).telegram.text,
    );
    expect(text).toContain(
      `Open signals: ${ICON.buy} #S-0045 BUY (-0.40R), ${ICON.sell} #S-0046 SELL (+0.20R).`,
    );
  });

  it('is valid Telegram HTML, and a hostile headline cannot add a tag', () => {
    const hostile = marketMoveMessage(
      {
        ...MOVE,
        causes: [
          {
            headline: frozenUnclassified({
              title: '<b>x</b> \uE001forged\uE002',
              url: 'https://example.com/',
              sourceName: 'A&B',
              publishedAt: T,
              firstSeenAt: T,
            }),
            at: T,
          },
        ],
      },
      EN,
    );
    expect(checkTelegramHtml(hostile.telegram.text)).toBeNull();
    expect(hostile.telegram.text).toContain('"&lt;b&gt;x&lt;/b&gt; forged" (A&amp;B, 21:44 IST)');
    expect(checkTelegramHtml(marketMoveMessage(MOVE, EN).telegram.text)).toBeNull();
    expect(checkTelegramHtml(marketMoveMessage(MOVE, HI).telegram.text)).toBeNull();
  });
});

describe('the rows of MARKET_MOVE', () => {
  it('has one for each channel under the key of the event, valid for 30 minutes', () => {
    expect(moveEventKey(12)).toBe('move:12:spike');
    const rows = marketMoveRows(MOVE, 12, SETTINGS, T);
    expect(rows.map((row) => [row.channel, row.kind, row.eventKey, row.expiresAt])).toEqual([
      ['telegram', 'MARKET_MOVE', 'move:12:spike', T + 30 * MIN],
      ['webpush', 'MARKET_MOVE', 'move:12:spike', T + 30 * MIN],
    ]);
    expect(rows[1]?.payload).toMatchObject({
      url: '/news?tab=moves',
      urgency: 'high',
      ttlSec: 1800,
    });
  });

  it('has none when the owner switched move alerts off, and none for a channel that is off', () => {
    expect(
      marketMoveRows(
        MOVE,
        12,
        { ...SETTINGS, newsAlerts: { ...NEWS_ALERTS, marketMoves: 'off' } },
        T,
      ),
    ).toEqual([]);
    const noWeb = {
      ...SETTINGS,
      alerts: { ...SETTINGS.alerts, webpush: { enabled: false, minGrade: 'Moderate' as const } },
    };
    expect(marketMoveRows(MOVE, 12, noWeb, T).map((row) => row.channel)).toEqual(['telegram']);
  });
});

describe('the headline feeds', () => {
  it('says that they are down, since when and for how long, and what is and is not affected', () => {
    const message = headlineFeedsDownMessage({ since: T - 12 * MIN, silentMs: 12 * MIN }, EN);
    expect(message.kind).toBe('SYSTEM_DEGRADED');
    expect(message.telegram.text).toBe(
      [
        `${ICON.feedDown} <b>HEADLINE FEEDS DOWN since 21:32 IST</b> (no feed answered for 12 min)`,
        'Headline alerts and the news line of new signals are unavailable. The price feed, the calendar and open signals are not affected.',
      ].join('\n'),
    );
    expect(message.push).toEqual({
      title: 'HEADLINE FEEDS DOWN',
      body: 'Since 21:32 IST. Headline alerts are unavailable.',
      urgency: 'normal',
      url: '/news?tab=headlines',
    });
  });

  it('says that they are back, after how long', () => {
    const message = headlineFeedsBackMessage({ at: T, downMs: 15 * MIN }, EN);
    expect(message.kind).toBe('SYSTEM_RECOVERED');
    expect(message.telegram.text).toBe(
      [
        `${ICON.feedUp} <b>HEADLINE FEEDS BACK 21:44 IST after 15 min.</b>`,
        'Headline alerts and the news line of signals work again.',
      ].join('\n'),
    );
    expect(message.push.body).toBe('At 21:44 IST, after 15 min.');
  });

  it('is in Hinglish too, and valid HTML', () => {
    const down = headlineFeedsDownMessage({ since: T - 12 * MIN, silentMs: 12 * MIN }, HI);
    expect(plain(down.telegram.text).split('\n')[0]).toBe(
      `${ICON.feedDown} HEADLINE FEEDS BAND, 21:32 IST se (12 min se kisi feed ne jawab nahi diya)`,
    );
    const back = headlineFeedsBackMessage({ at: T, downMs: 15 * MIN }, HI);
    expect(plain(back.telegram.text).split('\n')[0]).toBe(
      `${ICON.feedUp} HEADLINE FEEDS WAPAS 21:44 IST, 15 min baad.`,
    );
    for (const message of [down, back]) expect(checkTelegramHtml(message.telegram.text)).toBeNull();
  });

  it('names the outage by its start, so that a restart cannot tell it twice', () => {
    expect(headlineHealthEventKey(1792735320000, 'degraded')).toBe(
      'health:HEADLINES@1792735320000:degraded',
    );
    expect(headlineHealthEventKey(1792735320000, 'recovered')).toBe(
      'health:HEADLINES@1792735320000:recovered',
    );
  });
});

describe('no message claims a cause', () => {
  const CLAIMS = /\b(because of|led to|triggered|drove|driven by|caused by|due to|thanks to)\b/i;

  it('has no causal wording, except the sentence that says the cause is not known', () => {
    const texts = [EN, HI].flatMap((options) => [
      newsHeadlineMessage(HEADLINE, options).telegram.text,
      marketMoveMessage(MOVE, options).telegram.text,
      marketMoveMessage({ ...MOVE, causes: [] }, options).telegram.text,
      headlineFeedsDownMessage({ since: T, silentMs: 0 }, options).telegram.text,
    ]);
    for (const text of texts) {
      const without = plain(text)
        .replace('Whether the headline caused the move is not known.', '')
        .replace('Headline se move hua ya nahi, ye pata nahi.', '');
      expect(without).not.toMatch(CLAIMS);
      expect(without).not.toMatch(/\bcaused\b/i);
    }
  });

  it('says "possible causes" wherever it lists headlines as causes', () => {
    expect(plain(marketMoveMessage(MOVE, EN).telegram.text)).toContain(
      'Possible causes, not confirmed',
    );
    expect(plain(marketMoveMessage(MOVE, HI).telegram.text)).toContain(
      'Possible causes, confirm nahi',
    );
  });
});
