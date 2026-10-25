import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../domain';
import type { AlertSettings } from '../lifecycle/alerts';
import { checkTelegramHtml } from '../messages/markup';
import { ICON } from '../messages/style';
import { plain } from '../messages/test-html';
import type { DisplayOptions } from '../messages/types';
import { NEWS_ALERTS } from '../news/test-data';
import {
  SYSTEM_TTL_MS,
  alreadyPausedReply,
  enginePausedMessage,
  engineEventKey,
  feedDegradedMessage,
  feedRecoveredMessage,
  healthEventKey,
  notPausedReply,
  resumedReply,
  storageEventKey,
  storageWarningMessage,
  systemChannels,
  systemOutboxRows,
  systemMessage,
  testEventKey,
  testMessage,
} from './system';

const EN: DisplayOptions = { locale: 'en', displayTz: 'Asia/Kolkata' };
const HI: DisplayOptions = { locale: 'hinglish', displayTz: 'Asia/Kolkata' };
/** 2026-10-23 16:40 UTC is 22:10 IST. */
const AT = Date.UTC(2026, 9, 23, 16, 40, 0);
const MIN = 60_000;

/** What a reader sees of a message, line by line (the tags are checked in "the look"). */
const lines = (message: { text: string }): string[] => plain(message.text).split('\n');

describe('ENGINE_PAUSED', () => {
  it('says that the owner paused, what goes on, and how to continue', () => {
    const message = enginePausedMessage({ at: AT, until: null }, EN);
    expect(message.kind).toBe('ENGINE_PAUSED');
    expect(lines(message.telegram)).toEqual([
      `${ICON.paused} ENGINE PAUSED by you at 22:10 IST.`,
      'New signals are not sent. Data recording and tracking of open signals continue.',
      '/resume to continue.',
    ]);
    expect(message.push).toEqual({
      title: 'ENGINE PAUSED',
      body: 'New signals are not sent. Tracking continues.',
      urgency: 'normal',
    });
  });

  it('shows the end of a timed pause', () => {
    const message = enginePausedMessage({ at: AT, until: AT + 30 * MIN }, EN);
    expect(lines(message.telegram)).toEqual([
      `${ICON.paused} ENGINE PAUSED by you at 22:10 IST.`,
      'New signals are not sent. Data recording and tracking of open signals continue.',
      'Paused until 22:40 IST (30 min).',
      '/resume to continue.',
    ]);
    // a pause that runs into the next day names the date
    const overnight = enginePausedMessage({ at: AT, until: AT + 4 * 60 * MIN }, EN);
    expect(lines(overnight.telegram)[2]).toBe('Paused until 02:10 IST (24 Oct) (4 h).');
  });

  it('is written in Hinglish too', () => {
    const message = enginePausedMessage({ at: AT, until: null }, HI);
    expect(lines(message.telegram)[0]).toBe(
      `${ICON.paused} ENGINE PAUSE kiya aapne, 22:10 IST par.`,
    );
    expect(lines(message.telegram)[2]).toBe('Chalu karne ke liye /resume.');
  });
});

describe('the replies to /resume and a repeated /pause', () => {
  it('say what happened', () => {
    expect(plain(resumedReply(AT, EN).text)).toBe(
      `${ICON.running} ENGINE RESUMED at 22:10 IST.\nNew signals are sent again.`,
    );
    expect(alreadyPausedReply(AT, EN).text).toBe('The engine is already paused since 22:10 IST.');
    expect(notPausedReply(EN).text).toBe('The engine was not paused.');
    expect(notPausedReply(HI).text).toBe('Engine pause mein nahi tha.');
  });
});

describe('SYSTEM_DEGRADED and SYSTEM_RECOVERED', () => {
  it('a stale feed: since when, for how long, and which open trades cannot be tracked', () => {
    const message = feedDegradedMessage(
      { kind: 'STALE', since: AT, silentMs: 18_000, openSeqs: [45, 46] },
      EN,
    );
    expect(message.kind).toBe('SYSTEM_DEGRADED');
    expect(lines(message.telegram)).toEqual([
      `${ICON.feedDown} FEED STALE since 22:10 IST (no tick for 18 s)`,
      'New signals are blocked.',
      'Open trade #S-0045, #S-0046 cannot be tracked.',
    ]);
    expect(message.push).toEqual({
      title: 'FEED STALE',
      body: 'Since 22:10 IST. New signals are blocked.',
      urgency: 'high',
    });
  });

  it('a disconnected feed with no open trade and no known silence', () => {
    const message = feedDegradedMessage(
      { kind: 'DISCONNECT', since: AT, silentMs: null, openSeqs: [] },
      EN,
    );
    expect(lines(message.telegram)).toEqual([
      `${ICON.feedDown} FEED DISCONNECTED since 22:10 IST`,
      'New signals are blocked.',
    ]);
    expect(message.push.title).toBe('FEED DISCONNECTED');
  });

  it('is written in Hinglish', () => {
    const message = feedDegradedMessage(
      { kind: 'STALE', since: AT, silentMs: 18_000, openSeqs: [45] },
      HI,
    );
    expect(lines(message.telegram)).toEqual([
      `${ICON.feedDown} FEED STALE, 22:10 IST se (18 s se koi tick nahi)`,
      'Naye signals band hain.',
      'Khula trade #S-0045 track nahi ho sakta.',
    ]);
  });

  it('the recovery says how long it lasted and when new signals are expected', () => {
    const known = feedRecoveredMessage({ at: AT, downMs: 5 * MIN, resumeAt: AT + 60 * MIN }, EN);
    expect(known.kind).toBe('SYSTEM_RECOVERED');
    expect(lines(known.telegram)).toEqual([
      `${ICON.feedUp} FEED RECOVERED 22:10 IST after 5 min.`,
      'New signals resume at about 23:10 IST, after the warm-up.',
    ]);
    const unknown = feedRecoveredMessage({ at: AT, downMs: 90_000, resumeAt: null }, EN);
    expect(lines(unknown.telegram)).toEqual([
      `${ICON.feedUp} FEED RECOVERED 22:10 IST after 2 min.`,
      'New signals resume once the engine has warmed up again.',
    ]);
    expect(known.push).toEqual({
      title: 'FEED RECOVERED',
      body: 'At 22:10 IST, after 5 min.',
      urgency: 'normal',
    });
  });
});

describe('STORAGE_WARNING and TEST', () => {
  it('the storage warning names the budget, the new retention and the largest table', () => {
    const message = storageWarningMessage(
      { usedPercent: 82.4, budgetGb: 20, retentionDays: 3, largestTable: 'ticks', largestGb: 9.43 },
      EN,
    );
    expect(message.kind).toBe('STORAGE_WARNING');
    expect(lines(message.telegram)).toEqual([
      `${ICON.storage} STORAGE 82% of the 20 GB budget.`,
      'Tick retention shortened to 3 days.',
      'Largest table: ticks (9.4 GB).',
    ]);
    expect(message.push.title).toBe('STORAGE 82%');
  });

  it('the test message says it is not a signal', () => {
    const message = testMessage(AT, EN);
    expect(message.kind).toBe('TEST');
    expect(lines(message.telegram)).toEqual([
      `${ICON.test} TEST MESSAGE 22:10 IST`,
      'If you can read this, delivery works. Nothing here is a signal.',
    ]);
    expect(lines(testMessage(AT, HI).telegram)[1]).toContain('Ye koi signal nahi hai');
  });

  it('every system message is Telegram HTML, escaped as a whole, with a bold title', () => {
    const messages = [
      enginePausedMessage({ at: AT, until: AT + 30 * MIN }, EN),
      feedDegradedMessage({ kind: 'STALE', since: AT, silentMs: 1000, openSeqs: [45] }, EN),
      feedDegradedMessage({ kind: 'DISCONNECT', since: AT, silentMs: null, openSeqs: [] }, HI),
      feedRecoveredMessage({ at: AT, downMs: 5 * MIN, resumeAt: null }, EN),
      storageWarningMessage(
        { usedPercent: 82.4, budgetGb: 20, retentionDays: 3, largestTable: 'ticks', largestGb: 9 },
        HI,
      ),
      testMessage(AT, EN),
    ];
    for (const message of messages) {
      expect(checkTelegramHtml(message.telegram.text)).toBeNull();
      expect(message.telegram.text).toMatch(/^\S+ <b>[^<]+<\/b>/);
      expect(message.telegram.text).not.toMatch(/[\uE000-\uE00F]/);
      expect(message.telegram.level).toBe(0);
      expect(message.telegram.dropped).toEqual([]);
    }
  });
});

describe('the look: tags and pictures, exactly', () => {
  it('a stale feed: the title in bold behind a red picture, the rest plain', () => {
    expect(
      feedDegradedMessage({ kind: 'STALE', since: AT, silentMs: 18_000, openSeqs: [45] }, EN)
        .telegram.text,
    ).toBe(
      [
        `${ICON.feedDown} <b>FEED STALE since 22:10 IST</b> (no tick for 18 s)`,
        'New signals are blocked.',
        'Open trade #S-0045 cannot be tracked.',
      ].join('\n'),
    );
  });

  it('a recovery, a pause, a test and the reply to /resume', () => {
    expect(
      feedRecoveredMessage({ at: AT, downMs: 5 * MIN, resumeAt: null }, EN).telegram.text.split(
        '\n',
      )[0],
    ).toBe(`${ICON.feedUp} <b>FEED RECOVERED 22:10 IST after 5 min.</b>`);
    expect(enginePausedMessage({ at: AT, until: null }, EN).telegram.text.split('\n')[0]).toBe(
      `${ICON.paused} <b>ENGINE PAUSED by you at 22:10 IST.</b>`,
    );
    expect(testMessage(AT, EN).telegram.text.split('\n')[0]).toBe(
      `${ICON.test} <b>TEST MESSAGE 22:10 IST</b>`,
    );
    expect(resumedReply(AT, EN).text.split('\n')[0]).toBe(
      `${ICON.running} <b>ENGINE RESUMED at 22:10 IST.</b>`,
    );
  });
});

describe('event keys', () => {
  it('name the incident, the pause, the day and the test', () => {
    expect(healthEventKey('STALE', 1792735320000, 'degraded')).toBe(
      'health:STALE@1792735320000:degraded',
    );
    expect(healthEventKey('DISCONNECT', 1792735320000, 'recovered')).toBe(
      'health:DISCONNECT@1792735320000:recovered',
    );
    expect(engineEventKey('p1')).toBe('engine:p1:paused');
    expect(storageEventKey(Date.UTC(2026, 9, 23, 23, 59))).toBe('storage:20261023:warning');
    expect(testEventKey('abc')).toBe('test:abc');
  });
});

const SETTINGS: AlertSettings = {
  displayTz: 'Asia/Kolkata',
  locale: 'en',
  alerts: {
    telegram: { enabled: true, minGrade: 'Strong', kinds: [...NOTIFICATION_KINDS] },
    webpush: { enabled: true, minGrade: 'Very strong' },
  },
  strategyAlerts: {
    trend_pullback: 'off',
    sweep_reversal: 'off',
    squeeze_retest: 'off',
    trendline_retest: 'off',
    pattern_breakout: 'off',
  },
  newsAlerts: NEWS_ALERTS,
};

describe('systemChannels', () => {
  it('goes to the enabled channels, and Telegram only for the kinds that are on; grade and strategy switches do not apply', () => {
    expect(systemChannels(SETTINGS, 'SYSTEM_DEGRADED')).toEqual(['telegram', 'webpush']);
    const noWeb = {
      ...SETTINGS,
      alerts: { ...SETTINGS.alerts, webpush: { enabled: false, minGrade: 'Moderate' as const } },
    };
    expect(systemChannels(noWeb, 'TEST')).toEqual(['telegram']);
    const fewKinds = {
      ...SETTINGS,
      alerts: {
        ...SETTINGS.alerts,
        telegram: { ...SETTINGS.alerts.telegram, kinds: ['SIGNAL_NEW' as const] },
      },
    };
    expect(systemChannels(fewKinds, 'STORAGE_WARNING')).toEqual(['webpush']);
    const off = {
      ...SETTINGS,
      alerts: { ...SETTINGS.alerts, telegram: { ...SETTINGS.alerts.telegram, enabled: false } },
    };
    expect(systemChannels(off, 'TEST')).toEqual(['webpush']);
  });
});

describe('systemOutboxRows', () => {
  const message = feedDegradedMessage(
    { kind: 'STALE', since: AT, silentMs: 18_000, openSeqs: [] },
    EN,
  );
  const key = healthEventKey('STALE', AT, 'degraded');

  it('writes a row for each channel with the finished message, no signal and an hour to live', () => {
    const rows = systemOutboxRows(message, key, ['telegram', 'webpush'], AT);
    expect(rows).toEqual([
      {
        eventKey: key,
        channel: 'telegram',
        kind: 'SYSTEM_DEGRADED',
        signalId: null,
        payload: { text: message.telegram.text, level: 0, dropped: [] },
        expiresAt: AT + SYSTEM_TTL_MS,
      },
      {
        eventKey: key,
        channel: 'webpush',
        kind: 'SYSTEM_DEGRADED',
        signalId: null,
        payload: {
          title: 'FEED STALE',
          body: 'Since 22:10 IST. New signals are blocked.',
          url: '/',
          ttlSec: 3600,
          urgency: 'high',
          tag: key,
        },
        expiresAt: AT + SYSTEM_TTL_MS,
      },
    ]);
    expect(SYSTEM_TTL_MS).toBe(3_600_000);
  });

  it('keeps the order of the channels, writes only those asked for, and none for none', () => {
    expect(
      systemOutboxRows(message, key, ['webpush', 'telegram'], AT).map((row) => row.channel),
    ).toEqual(['telegram', 'webpush']);
    expect(systemOutboxRows(message, key, ['webpush'], AT).map((row) => row.channel)).toEqual([
      'webpush',
    ]);
    expect(systemOutboxRows(message, key, [], AT)).toEqual([]);
  });

  it('lives as long as it is told to, and the push lives at least a second whatever that is', () => {
    const [telegram, push] = systemOutboxRows(
      message,
      key,
      ['telegram', 'webpush'],
      AT,
      20 * 60_000,
    );
    expect(telegram?.expiresAt).toBe(AT + 20 * 60_000);
    expect(push?.payload).toMatchObject({ ttlSec: 1200 });
    const [short] = systemOutboxRows(message, key, ['webpush'], AT, 500);
    expect(short?.expiresAt).toBe(AT + 500);
    expect(short?.payload).toMatchObject({ ttlSec: 1 });
  });

  it('carries the page of the message to the push, and the front page when it has none', () => {
    const withPage = systemMessage('NEWS_UPCOMING', ['x'], {
      title: 't',
      body: 'b',
      urgency: 'normal',
      url: '/news',
    });
    const [push] = systemOutboxRows(withPage, 'news:1:upcoming', ['webpush'], AT);
    expect(push?.payload).toMatchObject({ url: '/news' });
    const [plainPush] = systemOutboxRows(message, key, ['webpush'], AT);
    expect(plainPush?.payload).toMatchObject({ url: '/' });
  });
});
