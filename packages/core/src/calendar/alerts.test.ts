import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../domain';
import type { AlertSettings } from '../lifecycle/alerts';
import { checkTelegramHtml } from '../messages/markup';
import { ICON } from '../messages/style';
import { plain } from '../messages/test-html';
import type { DisplayOptions } from '../messages/types';
import { NEWS_ALERTS } from '../news/test-data';
import {
  GOLD_AFTER_READY_MS,
  RELEASED_TTL_MS,
  UPCOMING_LEAD_MS,
  calendarChannels,
  calendarEventKey,
  newsReleasedMessage,
  newsUpcomingMessage,
  releasedDue,
  releasedOutboxRows,
  upcomingDue,
  upcomingOutboxRows,
  type CalendarPolicy,
} from './alerts';
import type { CalendarRecord } from './types';

const EN: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HI: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
/** 2026-10-23 12:30 UTC is 18:00 IST. */
const T = Date.UTC(2026, 9, 23, 12, 30, 0);
const MIN = 60_000;
const POLICY: CalendarPolicy = { currencies: ['USD'], minImpact: 'HIGH' };

const CPI: CalendarRecord = {
  id: 'ev-1',
  sourceEventId: 'mql5:277492',
  seriesId: 'mql5:840030005',
  scheduledAt: T,
  importance: 'high',
  currency: 'USD',
  countryCode: 'US',
  name: 'CPI m/m',
  unit: 'percent',
  multiplier: 'none',
  digits: 1,
  actual: null,
  forecast: 0.3,
  previous: 0.4,
  revisedPrevious: null,
  timeMode: 'exact',
  firstSeenAt: T - 86_400_000,
  actualFirstSeenAt: null,
};
const RELEASED: CalendarRecord = { ...CPI, actual: 0.5, actualFirstSeenAt: T + 40_000 };
const event = (change: Partial<CalendarRecord>): CalendarRecord => ({ ...CPI, ...change });

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

describe('the keys and the numbers', () => {
  it('name the event and the step, and the numbers are the documented ones', () => {
    expect(calendarEventKey('ev-1', 'upcoming')).toBe('news:ev-1:upcoming');
    expect(calendarEventKey('ev-1', 'released')).toBe('news:ev-1:released');
    expect(UPCOMING_LEAD_MS).toBe(30 * MIN);
    expect(RELEASED_TTL_MS).toBe(30 * MIN);
    expect(GOLD_AFTER_READY_MS).toBe(20_000);
  });
});

describe('upcomingDue', () => {
  it('has the events from thirty minutes ahead until they happen', () => {
    expect(upcomingDue([CPI], T - 31 * MIN, POLICY)).toEqual([]);
    expect(upcomingDue([CPI], T - 30 * MIN - 1, POLICY)).toEqual([]);
    expect(upcomingDue([CPI], T - 30 * MIN, POLICY)).toEqual([CPI]);
    expect(upcomingDue([CPI], T - 1, POLICY)).toEqual([CPI]);
    expect(upcomingDue([CPI], T, POLICY)).toEqual([]);
    expect(upcomingDue([CPI], T + MIN, POLICY)).toEqual([]);
  });

  it('only counts an event of the right currency and of at least the impact asked for', () => {
    const now = T - 10 * MIN;
    expect(upcomingDue([event({ currency: 'EUR' })], now, POLICY)).toEqual([]);
    expect(upcomingDue([event({ currency: null })], now, POLICY)).toEqual([]);
    expect(upcomingDue([event({ importance: 'medium' })], now, POLICY)).toEqual([]);
    expect(
      upcomingDue([event({ importance: 'medium' })], now, { ...POLICY, minImpact: 'MEDIUM' }),
    ).toHaveLength(1);
    expect(
      upcomingDue([event({ importance: 'low' })], now, { ...POLICY, minImpact: 'MEDIUM' }),
    ).toEqual([]);
    expect(
      upcomingDue([event({ importance: 'low' })], now, { ...POLICY, minImpact: 'LOW' }),
    ).toHaveLength(1);
    expect(
      upcomingDue([event({ currency: 'EUR' })], now, { ...POLICY, currencies: ['USD', 'EUR'] }),
    ).toHaveLength(1);
  });

  it('only counts down to an event with an exact time', () => {
    const now = T - 10 * MIN;
    expect(upcomingDue([event({ timeMode: 'tentative' })], now, POLICY)).toEqual([]);
    expect(upcomingDue([event({ timeMode: 'date' })], now, POLICY)).toEqual([]);
  });

  it('is in time order, the id deciding when two events share a time', () => {
    const a = event({ id: 'a', scheduledAt: T + 5 * MIN });
    const b = event({ id: 'b', scheduledAt: T + 5 * MIN });
    const c = event({ id: 'c', scheduledAt: T });
    expect(upcomingDue([b, a, c], T - 20 * MIN, POLICY).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('releasedDue', () => {
  it('has an event once its value was seen and gold can be measured, for half an hour', () => {
    expect(releasedDue([RELEASED], T + 19_999, POLICY)).toEqual([]);
    expect(releasedDue([RELEASED], T + 20_000, POLICY)).toEqual([RELEASED]);
    const seenAt = RELEASED.actualFirstSeenAt ?? 0;
    expect(releasedDue([RELEASED], seenAt + RELEASED_TTL_MS, POLICY)).toEqual([RELEASED]);
    expect(releasedDue([RELEASED], seenAt + RELEASED_TTL_MS + 1, POLICY)).toEqual([]);
  });

  it('has nothing for an event that was not released or whose release was not seen', () => {
    expect(releasedDue([CPI], T + MIN, POLICY)).toEqual([]);
    expect(releasedDue([event({ actual: 0.5, actualFirstSeenAt: null })], T + MIN, POLICY)).toEqual(
      [],
    );
  });

  it('has nothing for a value first seen long after its time (a backfill or a late restart)', () => {
    const late = event({ actual: 0.5, actualFirstSeenAt: T + RELEASED_TTL_MS + 1 });
    expect(releasedDue([late], T + RELEASED_TTL_MS + 2, POLICY)).toEqual([]);
    const justInTime = event({ actual: 0.5, actualFirstSeenAt: T + RELEASED_TTL_MS });
    expect(releasedDue([justInTime], T + RELEASED_TTL_MS + 2, POLICY)).toEqual([justInTime]);
  });

  it('has nothing for an event with only a date, but a tentative time with a value counts', () => {
    expect(releasedDue([{ ...RELEASED, timeMode: 'date' }], T + MIN, POLICY)).toEqual([]);
    expect(releasedDue([{ ...RELEASED, timeMode: 'tentative' }], T + MIN, POLICY)).toHaveLength(1);
  });

  it('only counts an event of the right currency and impact', () => {
    expect(releasedDue([{ ...RELEASED, currency: 'EUR' }], T + MIN, POLICY)).toEqual([]);
    expect(releasedDue([{ ...RELEASED, importance: 'medium' }], T + MIN, POLICY)).toEqual([]);
  });
});

describe('NEWS_UPCOMING', () => {
  const data = { event: CPI, now: T - 30 * MIN, window: { before: 45, after: 20 } };

  it('says what is coming, the forecast and the previous, and the window it opens', () => {
    const message = newsUpcomingMessage(data, EN);
    expect(message.kind).toBe('NEWS_UPCOMING');
    expect(message.telegram.text).toBe(
      [
        `${ICON.macro} <b>HIGH-IMPACT USD EVENT in 30 min: CPI m/m (18:00 IST)</b>`,
        'Forecast 0.3%  Previous 0.4%.',
        'Signals are still sent, but from 17:15 IST until volatility normalises after 18:20 IST they carry a NEWS WINDOW warning.',
      ].join('\n'),
    );
    expect(message.push).toEqual({
      title: 'HIGH-IMPACT USD EVENT in 30 min',
      body: 'CPI m/m, 18:00 IST.',
      urgency: 'normal',
      url: '/news',
    });
  });

  it('is written in Hinglish too, with the same numbers', () => {
    expect(plain(newsUpcomingMessage(data, HI).telegram.text)).toBe(
      [
        `${ICON.macro} HIGH-IMPACT USD EVENT 30 min mein: CPI m/m (18:00 IST)`,
        'Forecast 0.3%  Pichhla 0.4%.',
        'Signals bheje jaate rahenge, par 17:15 IST se 18:20 IST ke baad volatility normal hone tak un par NEWS WINDOW chetavni rahegi.',
      ].join('\n'),
    );
  });

  it('counts the minutes up, and never says 0', () => {
    const at = (now: number) => plain(newsUpcomingMessage({ ...data, now }, EN).telegram.text);
    expect(at(T - 29 * MIN - 30_000)).toContain('in 30 min:');
    expect(at(T - 5 * MIN)).toContain('in 5 min:');
    expect(at(T - 1_000)).toContain('in 1 min:');
  });

  it('leaves out the window when the event opens none, and shows a missing figure as a dash', () => {
    const lines = newsUpcomingMessage(
      { ...data, event: event({ forecast: null, previous: null }), window: null },
      EN,
    ).telegram.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('Forecast -  Previous -.');
  });

  it('names a medium event as such, and an event with no currency without one', () => {
    expect(
      plain(
        newsUpcomingMessage({ ...data, event: event({ importance: 'medium' }) }, EN).telegram.text,
      ),
    ).toContain('MEDIUM-IMPACT USD EVENT');
    expect(
      plain(newsUpcomingMessage({ ...data, event: event({ currency: null }) }, EN).telegram.text),
    ).toContain('HIGH-IMPACT EVENT in 30 min');
  });

  it('shows the day when the event is on another day of the display zone', () => {
    const text = plain(
      newsUpcomingMessage({ ...data, now: T - 30 * MIN - 24 * 60 * MIN }, EN).telegram.text,
    );
    expect(text).toContain('(18:00 IST (23 Oct))');
  });

  it('is valid Telegram HTML, and text from outside cannot add a tag', () => {
    const hostile = event({ name: 'CPI \uE001forged\uE002 <b>x</b>', currency: 'U\uE001S' });
    const text = newsUpcomingMessage({ ...data, event: hostile }, EN).telegram.text;
    expect(checkTelegramHtml(text)).toBeNull();
    expect(text).toContain('CPI forged &lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('HIGH-IMPACT US EVENT');
    expect(text).not.toMatch(/[\uE000-\uE00F]/);
  });
});

describe('NEWS_RELEASED', () => {
  const data = {
    event: RELEASED,
    sigma: 2.14,
    goldAfter: { seconds: 15, moveUsd: -3.1, spread: 0.9 },
    opensWindow: true,
  };

  it('says the figures, the surprise, where gold was 15 s later and that the window is on', () => {
    const message = newsReleasedMessage(data, EN);
    expect(message.kind).toBe('NEWS_RELEASED');
    expect(message.telegram.text).toBe(
      [
        `${ICON.released} <b>CPI m/m released 18:00 IST</b>`,
        'Actual 0.5%, forecast 0.3%, previous 0.4% (surprise +2.1 sigma).',
        'Gold 15 s after: -3.100 USD, spread 0.900.',
        'Signals in this window carry a NEWS WINDOW warning until spread and ATR normalise.',
      ].join('\n'),
    );
    expect(message.push).toEqual({
      title: 'CPI m/m released',
      body: 'Actual 0.5%, forecast 0.3%.',
      urgency: 'normal',
      url: '/news',
    });
  });

  it('in Hinglish', () => {
    expect(plain(newsReleasedMessage(data, HI).telegram.text)).toBe(
      [
        `${ICON.released} CPI m/m aa gaya, 18:00 IST`,
        'Actual 0.5%, forecast 0.3%, pichhla 0.4% (surprise +2.1 sigma).',
        'Gold 15 s baad: -3.100 USD, spread 0.900.',
        'Is window ke signals par NEWS WINDOW chetavni rahegi jab tak spread aur ATR normal nahi hote.',
      ].join('\n'),
    );
  });

  it('says nothing that could not be measured: no surprise, no gold, no revision, no window', () => {
    const lines = newsReleasedMessage(
      { event: RELEASED, sigma: null, goldAfter: null, opensWindow: false },
      EN,
    ).telegram.text.split('\n');
    expect(lines).toEqual([
      `${ICON.released} <b>CPI m/m released 18:00 IST</b>`,
      'Actual 0.5%, forecast 0.3%, previous 0.4%.',
    ]);
  });

  it('shows a revised previous value, a missing forecast, and gold without a spread', () => {
    const text = plain(
      newsReleasedMessage(
        {
          event: { ...RELEASED, revisedPrevious: 0.5, forecast: null },
          sigma: -0.04,
          goldAfter: { seconds: 15, moveUsd: 1.25, spread: null },
          opensWindow: false,
        },
        EN,
      ).telegram.text,
    );
    expect(text).toContain(
      'Actual 0.5%, forecast -, previous 0.4% (revised 0.5%) (surprise 0.0 sigma).',
    );
    expect(text).toContain('Gold 15 s after: +1.250 USD.');
  });

  it('refuses an event that was not released', () => {
    expect(() => newsReleasedMessage({ ...data, event: CPI }, EN)).toThrow(RangeError);
  });

  it('is valid Telegram HTML', () => {
    expect(checkTelegramHtml(newsReleasedMessage(data, EN).telegram.text)).toBeNull();
    expect(checkTelegramHtml(newsReleasedMessage(data, HI).telegram.text)).toBeNull();
  });
});

describe('calendarChannels', () => {
  it('follows the system rule, and the impact that the news alerts ask for', () => {
    expect(calendarChannels(SETTINGS, 'NEWS_UPCOMING', 'high')).toEqual(['telegram', 'webpush']);
    expect(calendarChannels(SETTINGS, 'NEWS_UPCOMING', 'medium')).toEqual([]);
    expect(
      calendarChannels(
        { ...SETTINGS, newsAlerts: { ...SETTINGS.newsAlerts, minImpact: 'MEDIUM' } },
        'NEWS_RELEASED',
        'medium',
      ),
    ).toEqual(['telegram', 'webpush']);
    expect(
      calendarChannels(
        { ...SETTINGS, newsAlerts: { ...SETTINGS.newsAlerts, minImpact: 'MEDIUM' } },
        'NEWS_RELEASED',
        'low',
      ),
    ).toEqual([]);
    expect(
      calendarChannels(
        { ...SETTINGS, newsAlerts: { ...SETTINGS.newsAlerts, minImpact: 'LOW' } },
        'NEWS_RELEASED',
        'low',
      ),
    ).toEqual(['telegram', 'webpush']);
  });

  it('leaves Telegram out when the kind is switched off, and Web Push when it is off', () => {
    const noKind = {
      ...SETTINGS,
      alerts: {
        ...SETTINGS.alerts,
        telegram: {
          ...SETTINGS.alerts.telegram,
          kinds: SETTINGS.alerts.telegram.kinds.filter((kind) => kind !== 'NEWS_UPCOMING'),
        },
      },
    };
    expect(calendarChannels(noKind, 'NEWS_UPCOMING', 'high')).toEqual(['webpush']);
    expect(calendarChannels(noKind, 'NEWS_RELEASED', 'high')).toEqual(['telegram', 'webpush']);
    const noWeb = {
      ...SETTINGS,
      alerts: { ...SETTINGS.alerts, webpush: { enabled: false, minGrade: 'Moderate' as const } },
    };
    expect(calendarChannels(noWeb, 'NEWS_UPCOMING', 'high')).toEqual(['telegram']);
  });
});

describe('the outbox rows', () => {
  it('NEWS_UPCOMING lives until the event, with its own key, for each channel', () => {
    const now = T - 20 * MIN;
    const rows = upcomingOutboxRows(
      { event: CPI, now, window: { before: 45, after: 20 } },
      SETTINGS,
      now,
    );
    expect(
      rows.map((row) => [row.channel, row.kind, row.eventKey, row.signalId, row.expiresAt]),
    ).toEqual([
      ['telegram', 'NEWS_UPCOMING', 'news:ev-1:upcoming', null, T],
      ['webpush', 'NEWS_UPCOMING', 'news:ev-1:upcoming', null, T],
    ]);
    expect(rows[1]?.payload).toMatchObject({
      url: '/news',
      ttlSec: 1200,
      tag: 'news:ev-1:upcoming',
      urgency: 'normal',
    });
    expect(String(rows[0]?.payload.text)).toContain('in 20 min');
  });

  it('NEWS_UPCOMING written at the last moment still lives for a second', () => {
    const rows = upcomingOutboxRows({ event: CPI, now: T, window: null }, SETTINGS, T);
    expect(rows[0]?.expiresAt).toBe(T + 1_000);
  });

  it('NEWS_RELEASED lives for half an hour from now', () => {
    const now = T + MIN;
    const rows = releasedOutboxRows(
      { event: RELEASED, sigma: null, goldAfter: null, opensWindow: false },
      SETTINGS,
      now,
    );
    expect(rows.map((row) => [row.channel, row.kind, row.eventKey, row.expiresAt])).toEqual([
      ['telegram', 'NEWS_RELEASED', 'news:ev-1:released', now + RELEASED_TTL_MS],
      ['webpush', 'NEWS_RELEASED', 'news:ev-1:released', now + RELEASED_TTL_MS],
    ]);
    expect(rows[1]?.payload).toMatchObject({ ttlSec: 1800, url: '/news' });
  });

  it('are written in the language of the settings, and none for an event below the impact asked for', () => {
    const hinglish = { ...SETTINGS, locale: 'hinglish' as const };
    const rows = upcomingOutboxRows({ event: CPI, now: T - MIN, window: null }, hinglish, T - MIN);
    expect(String(rows[0]?.payload.text)).toContain('EVENT 1 min mein');
    expect(
      upcomingOutboxRows(
        { event: event({ importance: 'medium' }), now: T - MIN, window: null },
        SETTINGS,
        T - MIN,
      ),
    ).toEqual([]);
  });
});
