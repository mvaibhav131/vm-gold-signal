import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../domain';
import { RESULT_TTL_SEC, signalEventKey } from '../messages/push';
import { NEWS_ALERTS } from '../news/test-data';
import {
  renderFinalReview,
  renderSignalCancelled,
  renderSignalClosed,
  renderSignalTp1,
} from '../messages/results';
import { renderSignalNew } from '../messages/signalNew';
import {
  BUY_SIGNAL,
  FINAL_REVIEW,
  LOSS,
  MINUTE,
  REVIEW,
  SELL_SIGNAL,
  WIN_TP2,
  newSignal,
} from '../messages/test-data';
import {
  displayOptionsOf,
  expiresAtOf,
  followUpChannels,
  gradeAtLeast,
  newSignalChannels,
  signalOutboxRows,
  type AlertSettings,
  type SignalMessage,
} from './alerts';

const SETTINGS: AlertSettings = {
  displayTz: 'Asia/Kolkata',
  locale: 'en',
  alerts: {
    telegram: { enabled: true, minGrade: 'Moderate', kinds: [...NOTIFICATION_KINDS] },
    webpush: { enabled: false, minGrade: 'Moderate' },
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

const settings = (change: {
  telegram?: Partial<AlertSettings['alerts']['telegram']>;
  webpush?: Partial<AlertSettings['alerts']['webpush']>;
  locale?: AlertSettings['locale'];
  strategyAlerts?: Partial<AlertSettings['strategyAlerts']>;
}): AlertSettings => ({
  ...SETTINGS,
  locale: change.locale ?? SETTINGS.locale,
  alerts: {
    telegram: { ...SETTINGS.alerts.telegram, ...change.telegram },
    webpush: { ...SETTINGS.alerts.webpush, ...change.webpush },
  },
  strategyAlerts: { ...SETTINGS.strategyAlerts, ...change.strategyAlerts },
});

describe('gradeAtLeast', () => {
  it('orders the grades: Moderate, Strong, Very strong', () => {
    expect(gradeAtLeast('Moderate', 'Moderate')).toBe(true);
    expect(gradeAtLeast('Moderate', 'Strong')).toBe(false);
    expect(gradeAtLeast('Moderate', 'Very strong')).toBe(false);
    expect(gradeAtLeast('Strong', 'Moderate')).toBe(true);
    expect(gradeAtLeast('Strong', 'Strong')).toBe(true);
    expect(gradeAtLeast('Strong', 'Very strong')).toBe(false);
    expect(gradeAtLeast('Very strong', 'Moderate')).toBe(true);
    expect(gradeAtLeast('Very strong', 'Strong')).toBe(true);
    expect(gradeAtLeast('Very strong', 'Very strong')).toBe(true);
  });
});

describe('newSignalChannels: who is told about a new signal', () => {
  it('is Telegram by default, and nobody for a strategy in shadow mode', () => {
    expect(newSignalChannels(SETTINGS, 'trend_pullback', 'Moderate')).toEqual(['telegram']);
    expect(newSignalChannels(SETTINGS, 'trendline_retest', 'Very strong')).toEqual([]);
    expect(newSignalChannels(SETTINGS, 'pattern_breakout', 'Very strong')).toEqual([]);
    expect(
      newSignalChannels(
        settings({ strategyAlerts: { trendline_retest: 'on' } }),
        'trendline_retest',
        'Moderate',
      ),
    ).toEqual(['telegram']);
  });

  it('needs the channel enabled', () => {
    expect(
      newSignalChannels(settings({ telegram: { enabled: false } }), 'trend_pullback', 'Strong'),
    ).toEqual([]);
    expect(
      newSignalChannels(settings({ webpush: { enabled: true } }), 'trend_pullback', 'Moderate'),
    ).toEqual(['telegram', 'webpush']);
    expect(
      newSignalChannels(
        settings({ telegram: { enabled: false }, webpush: { enabled: true } }),
        'sweep_reversal',
        'Moderate',
      ),
    ).toEqual(['webpush']);
  });

  it('needs the grade of the signal to reach the minimum of the channel', () => {
    const strict = settings({
      telegram: { minGrade: 'Strong' },
      webpush: { enabled: true, minGrade: 'Very strong' },
    });
    expect(newSignalChannels(strict, 'trend_pullback', 'Moderate')).toEqual([]);
    expect(newSignalChannels(strict, 'trend_pullback', 'Strong')).toEqual(['telegram']);
    expect(newSignalChannels(strict, 'trend_pullback', 'Very strong')).toEqual([
      'telegram',
      'webpush',
    ]);
  });

  it('Telegram also needs the kind SIGNAL_NEW to be on, Web Push has no kinds', () => {
    const noNew = settings({
      telegram: { kinds: NOTIFICATION_KINDS.filter((kind) => kind !== 'SIGNAL_NEW') },
      webpush: { enabled: true },
    });
    expect(newSignalChannels(noNew, 'trend_pullback', 'Strong')).toEqual(['webpush']);
  });
});

describe('followUpChannels: who gets TP1, the result, the cancellation and the review', () => {
  it('is only where the owner was told about the entry', () => {
    const both = settings({ webpush: { enabled: true } });
    expect(followUpChannels(both, 'SIGNAL_CLOSED', ['telegram', 'webpush'])).toEqual([
      'telegram',
      'webpush',
    ]);
    expect(followUpChannels(both, 'SIGNAL_CLOSED', ['telegram'])).toEqual(['telegram']);
    expect(followUpChannels(both, 'SIGNAL_CLOSED', ['webpush'])).toEqual(['webpush']);
    expect(followUpChannels(both, 'SIGNAL_CLOSED', [])).toEqual([]);
  });

  it('still follows the settings of the moment: a channel switched off, or a kind taken out', () => {
    expect(
      followUpChannels(settings({ telegram: { enabled: false } }), 'SIGNAL_TP1', ['telegram']),
    ).toEqual([]);
    expect(
      followUpChannels(
        settings({ telegram: { kinds: ['SIGNAL_NEW', 'SIGNAL_CLOSED'] } }),
        'SIGNAL_TP1',
        ['telegram'],
      ),
    ).toEqual([]);
    expect(
      followUpChannels(
        settings({ telegram: { kinds: ['SIGNAL_NEW', 'SIGNAL_CLOSED'] } }),
        'SIGNAL_CLOSED',
        ['telegram'],
      ),
    ).toEqual(['telegram']);
    expect(followUpChannels(SETTINGS, 'SIGNAL_CLOSED', ['webpush'])).toEqual([]);
  });

  it('does not look at the grade or the strategy switch again', () => {
    const changed = settings({
      telegram: { minGrade: 'Very strong' },
      strategyAlerts: { trend_pullback: 'off' },
    });
    expect(followUpChannels(changed, 'SIGNAL_REVIEW_FINAL', ['telegram'])).toEqual(['telegram']);
  });
});

describe('signalOutboxRows', () => {
  const NOW = BUY_SIGNAL.generatedAt + 40 * MINUTE;
  const options = displayOptionsOf(SETTINGS);
  const both = ['telegram', 'webpush'] as const;

  const messages: {
    name: string;
    message: SignalMessage;
    step: 'confirmed' | 'tp1' | 'closed' | 'review';
  }[] = [
    { name: 'a new signal', message: { kind: 'SIGNAL_NEW', data: newSignal() }, step: 'confirmed' },
    {
      name: 'TP1',
      message: {
        kind: 'SIGNAL_TP1',
        data: { signal: BUY_SIGNAL, at: BUY_SIGNAL.generatedAt + 6 * MINUTE, price: 4023.84 },
      },
      step: 'tp1',
    },
    {
      name: 'a result',
      message: {
        kind: 'SIGNAL_CLOSED',
        data: { signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW },
      },
      step: 'closed',
    },
    {
      name: 'a cancellation',
      message: { kind: 'SIGNAL_CANCELLED', data: { signal: BUY_SIGNAL, staleSeconds: 40 } },
      step: 'closed',
    },
    {
      name: 'a final review',
      message: {
        kind: 'SIGNAL_REVIEW_FINAL',
        data: {
          signal: BUY_SIGNAL,
          review: FINAL_REVIEW,
          previousPrimary: 'NO_FOLLOW_THROUGH',
          trackedThisMonth: 3,
        },
      },
      step: 'review',
    },
  ];

  it.each(messages)(
    '$name: one row for each channel, with the key of its step',
    ({ message, step }) => {
      const rows = signalOutboxRows(message, options, both, NOW);
      expect(rows.map((row) => row.channel)).toEqual(['telegram', 'webpush']);
      for (const row of rows) {
        expect(row.eventKey).toBe(signalEventKey(BUY_SIGNAL.id, step));
        expect(row.kind).toBe(message.kind);
        expect(row.signalId).toBe(BUY_SIGNAL.id);
      }
    },
  );

  it('the Telegram payload is the rendered text, the push payload the push without its kind', () => {
    const [telegram, push] = signalOutboxRows(
      { kind: 'SIGNAL_NEW', data: newSignal() },
      options,
      both,
      NOW,
    );
    const rendered = renderSignalNew(newSignal(), options);
    expect(telegram?.payload).toEqual({
      text: rendered.text,
      level: rendered.level,
      dropped: rendered.dropped,
    });
    expect(Object.keys(push?.payload ?? {}).sort()).toEqual([
      'body',
      'tag',
      'title',
      'ttlSec',
      'urgency',
      'url',
    ]);
    expect(push?.payload).toMatchObject({
      url: `/signals/${BUY_SIGNAL.id}`,
      tag: signalEventKey(BUY_SIGNAL.id, 'confirmed'),
      urgency: 'high',
    });
  });

  it('writes every kind of message with the renderer of its kind', () => {
    const texts = messages.map(
      ({ message }) => signalOutboxRows(message, options, ['telegram'], NOW)[0]?.payload.text,
    );
    expect(texts).toEqual([
      renderSignalNew(newSignal(), options).text,
      renderSignalTp1(
        { signal: BUY_SIGNAL, at: BUY_SIGNAL.generatedAt + 6 * MINUTE, price: 4023.84 },
        options,
      ).text,
      renderSignalClosed({ signal: BUY_SIGNAL, outcome: LOSS, review: REVIEW }, options).text,
      renderSignalCancelled({ signal: BUY_SIGNAL, staleSeconds: 40 }, options).text,
      renderFinalReview(
        {
          signal: BUY_SIGNAL,
          review: FINAL_REVIEW,
          previousPrimary: 'NO_FOLLOW_THROUGH',
          trackedThisMonth: 3,
        },
        options,
      ).text,
    ]);
  });

  it('writes in the language of the settings', () => {
    const message: SignalMessage = { kind: 'SIGNAL_NEW', data: newSignal() };
    const en = signalOutboxRows(message, options, ['telegram'], NOW)[0]?.payload.text;
    const hinglish = signalOutboxRows(
      message,
      displayOptionsOf(settings({ locale: 'hinglish' })),
      ['telegram'],
      NOW,
    )[0]?.payload.text;
    expect(typeof en).toBe('string');
    expect(hinglish).not.toEqual(en);
  });

  it('gives only the channels asked for, in a fixed order, and nothing for no channel', () => {
    const message: SignalMessage = { kind: 'SIGNAL_NEW', data: newSignal() };
    expect(
      signalOutboxRows(message, options, ['webpush', 'telegram'], NOW).map((r) => r.channel),
    ).toEqual(['telegram', 'webpush']);
    expect(signalOutboxRows(message, options, ['webpush'], NOW).map((r) => r.channel)).toEqual([
      'webpush',
    ]);
    expect(signalOutboxRows(message, options, [], NOW)).toEqual([]);
  });

  it('the payload is plain JSON, so it survives the database', () => {
    for (const { message } of messages) {
      for (const row of signalOutboxRows(message, options, both, NOW)) {
        expect(JSON.parse(JSON.stringify(row.payload))).toEqual(row.payload);
      }
    }
  });

  it('the entry alert expires when the entry validity ends, every other message 6 hours after it was written', () => {
    for (const { message } of messages) {
      const [row] = signalOutboxRows(message, options, ['telegram'], NOW);
      expect(row?.expiresAt).toBe(
        message.kind === 'SIGNAL_NEW' ? BUY_SIGNAL.entryValidUntil : NOW + RESULT_TTL_SEC * 1000,
      );
      expect(expiresAtOf(message, NOW)).toBe(row?.expiresAt);
    }
    expect(RESULT_TTL_SEC).toBe(6 * 3600);
  });

  it('keeps the numbers of a SELL and of a win as they are', () => {
    const sell = signalOutboxRows(
      { kind: 'SIGNAL_NEW', data: newSignal(SELL_SIGNAL) },
      options,
      ['telegram'],
      NOW,
    )[0];
    expect(String(sell?.payload.text)).toContain('SELL');
    const win = signalOutboxRows(
      { kind: 'SIGNAL_CLOSED', data: { signal: BUY_SIGNAL, outcome: WIN_TP2, review: null } },
      options,
      ['telegram'],
      NOW,
    )[0];
    expect(String(win?.payload.text)).toContain('+1.47R');
  });

  it('refuses what the renderers refuse: a closed message for a cancelled outcome', () => {
    expect(() =>
      signalOutboxRows(
        {
          kind: 'SIGNAL_CLOSED',
          data: {
            signal: BUY_SIGNAL,
            outcome: { ...LOSS, result: 'CANCELLED', countsInStats: false },
            review: null,
          },
        },
        options,
        ['webpush'],
        NOW,
      ),
    ).toThrow(RangeError);
  });
});

describe('displayOptionsOf', () => {
  it('is the language and the time zone of the settings', () => {
    expect(displayOptionsOf(settings({ locale: 'hinglish' }))).toEqual({
      locale: 'hinglish',
      displayTz: 'Asia/Kolkata',
    });
  });
});
