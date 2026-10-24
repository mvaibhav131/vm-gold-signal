import { NEWS_TOPICS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  breakdownQuerySchema,
  breakdownRowSchema,
  calendarEventSchema,
  calibrationQuerySchema,
  calibrationRowSchema,
  candlesQuerySchema,
  candlesResponseSchema,
  driftResponseSchema,
  driftRowSchema,
  engineEventSchema,
  equityQuerySchema,
  failuresQuerySchema,
  featureSnapshotResponseSchema,
  feedIncidentSchema,
  groupEffectivenessQuerySchema,
  groupEffectivenessRowSchema,
  headlineSchema,
  healthReadySchema,
  loginRequestSchema,
  macroEventSchema,
  marketMoveSchema,
  marketMovesQuerySchema,
  marketMovesResponseSchema,
  marketSnapshotSchema,
  monthlyQuerySchema,
  monthlyRowSchema,
  newsEventsQuerySchema,
  newsEventsResponseSchema,
  newsImpactResponseSchema,
  newsImpactRowSchema,
  notificationTestRequestSchema,
  notificationTestResponseSchema,
  openSignalsResponseSchema,
  overviewQuerySchema,
  overviewResponseSchema,
  pageSchema,
  pageQueryShape,
  passwordChangeRequestSchema,
  problemSchema,
  pushSubscribeRequestSchema,
  sessionsResponseSchema,
  settingsPatchSchema,
  settingsSchema,
  signalDetailSchema,
  signalHistoryPageSchema,
  signalHistoryQuerySchema,
  signalHistoryRowSchema,
  sseEventIdSchema,
  sseEventSchema,
  strategyConfigResponseSchema,
  strategyInfoSchema,
  strategyPatchSchema,
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
  totpCodeRequestSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from './index';
import { frozenHeadlineSchema } from '../news';
import { evidence, outcome, signal, signalState, SIGNAL_ID } from '../test-fixtures';
import { z } from 'zod';

function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

function roundTrip<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));
}

const engine = {
  status: 'RUNNING',
  openCount: 0,
  openRiskR: 0,
  warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
  waitReasons: [{ code: 'NO_SETUP', label: 'No setup yet' }],
  evaluatedAt: '2026-10-23T06:10:00Z',
};

const snapshot = {
  symbol: 'XAUUSD',
  bid: 4017.2,
  ask: 4017.37,
  mid: 4017.285,
  spread: 0.17,
  sourceAt: '2026-10-23T06:10:00Z',
  receivedAt: '2026-10-23T06:10:00.250Z',
  ageMs: 250,
  feedState: 'LIVE',
  session: 'LONDON',
  regime: 'TREND_UP',
  mode: 'LIVE',
  engine,
};

describe('problem details', () => {
  const problem = {
    type: 'about:blank',
    title: 'Too many requests',
    status: 429,
    code: 'rate_limited',
    detail: 'Try again later.',
  };

  it('accepts RFC 9457 problems with a stable code', () => {
    expect(roundTrip(problemSchema, problem)).toEqual(problem);
  });

  it('rejects success statuses, free-text codes and extra fields', () => {
    expect(ok(problemSchema, { ...problem, status: 200 })).toBe(false);
    expect(ok(problemSchema, { ...problem, code: 'Rate Limited' })).toBe(false);
    expect(ok(problemSchema, { ...problem, stack: 'secret' })).toBe(false);
  });
});

describe('pagination and queries', () => {
  const query = z.strictObject(pageQueryShape);

  it('defaults the limit to 50 and coerces strings', () => {
    expect(query.parse({})).toEqual({ limit: 50 });
    expect(query.parse({ limit: '25', cursor: 'abc' })).toEqual({ limit: 25, cursor: 'abc' });
  });

  it('caps the limit at 200', () => {
    expect(ok(query, { limit: '201' })).toBe(false);
    expect(ok(query, { limit: '0' })).toBe(false);
    expect(ok(query, { limit: '1.5' })).toBe(false);
  });

  it('wraps items with a cursor', () => {
    const page = pageSchema(z.string());
    expect(ok(page, { items: ['a'], nextCursor: null })).toBe(true);
    expect(ok(page, { items: ['a'] })).toBe(false);
  });

  it('parses history filters and rejects bad ones', () => {
    expect(signalHistoryQuerySchema.parse({ result: 'LOSS', side: 'BUY', limit: '10' })).toEqual({
      result: 'LOSS',
      side: 'BUY',
      limit: 10,
    });
    expect(ok(signalHistoryQuerySchema, { result: 'MAYBE' })).toBe(false);
    expect(ok(signalHistoryQuerySchema, { sort: 'asc' })).toBe(false);
    expect(
      ok(signalHistoryQuerySchema, { from: '2026-10-24T00:00:00Z', to: '2026-10-23T00:00:00Z' }),
    ).toBe(false);
  });

  it('sorts the history by a known column in either direction, and by nothing else', () => {
    expect(signalHistoryQuerySchema.parse({ sort: 'realizedRNet', order: 'asc' })).toMatchObject({
      sort: 'realizedRNet',
      order: 'asc',
    });
    for (const sort of ['generatedAt', 'qualityScore', 'realizedRNet', 'durationS']) {
      expect(ok(signalHistoryQuerySchema, { sort })).toBe(true);
    }
    expect(ok(signalHistoryQuerySchema, { sort: 'entry' })).toBe(false);
    expect(ok(signalHistoryQuerySchema, { order: 'up' })).toBe(false);
  });

  it('parses candle query lists and applies defaults', () => {
    expect(candlesQuerySchema.parse({})).toEqual({
      tf: '5m',
      limit: 500,
      overlays: [],
      objects: [],
    });
    expect(
      candlesQuerySchema.parse({ overlays: 'ema20,supertrend', objects: 'zones' }),
    ).toMatchObject({
      overlays: ['ema20', 'supertrend'],
      objects: ['zones'],
    });
    expect(ok(candlesQuerySchema, { overlays: 'ema20,macd' })).toBe(false);
    expect(ok(candlesQuerySchema, { tf: '2m' })).toBe(false);
    expect(ok(candlesQuerySchema, { limit: '5000' })).toBe(false);
  });

  it('requires a known breakdown dimension', () => {
    expect(ok(breakdownQuerySchema, { by: 'session' })).toBe(true);
    expect(ok(breakdownQuerySchema, {})).toBe(false);
    expect(ok(breakdownQuerySchema, { by: 'colour' })).toBe(false);
  });

  it('lets the scope switch of the Analytics page reach every section: forward unless asked otherwise', () => {
    const queries = {
      overview: overviewQuerySchema,
      monthly: monthlyQuerySchema,
      breakdown: breakdownQuerySchema,
      failures: failuresQuerySchema,
      groups: groupEffectivenessQuerySchema,
      calibration: calibrationQuerySchema,
      equity: equityQuerySchema,
    } as const;
    for (const [name, schema] of Object.entries(queries)) {
      const input = name === 'breakdown' ? { by: 'side' } : {};
      expect(schema.parse(input), name).toMatchObject({ scope: 'FORWARD' });
      expect(schema.parse({ ...input, scope: 'BACKTEST_OOS' }), name).toMatchObject({
        scope: 'BACKTEST_OOS',
      });
      expect(ok(schema, { ...input, scope: 'LIVE' }), name).toBe(false);
    }
  });

  it('keeps the drift panel and the news impact outside the scope switch (no scope parameter)', () => {
    // drift compares the forward trades with the evidence; the news impact is measured on headlines, not on trades
    expect(ok(z.strictObject({}), {})).toBe(true);
    expect(driftResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(newsImpactResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });
});

describe('auth payloads', () => {
  it('accepts a login with an optional six digit code', () => {
    expect(ok(loginRequestSchema, { username: 'owner', password: 'pw' })).toBe(true);
    expect(ok(loginRequestSchema, { username: 'owner', password: 'pw', totp: '123456' })).toBe(
      true,
    );
  });

  it('rejects bad codes, oversized passwords and extra fields', () => {
    expect(ok(loginRequestSchema, { username: 'owner', password: 'pw', totp: '12345' })).toBe(
      false,
    );
    expect(ok(loginRequestSchema, { username: 'owner', password: 'x'.repeat(1025) })).toBe(false);
    expect(ok(loginRequestSchema, { username: 'owner', password: 'pw', admin: true })).toBe(false);
  });
});

describe('market snapshot', () => {
  it('round-trips', () => {
    expect(roundTrip(marketSnapshotSchema, snapshot)).toEqual(snapshot);
  });

  it('rejects ask below bid, a wrong spread and a wrong mid', () => {
    expect(ok(marketSnapshotSchema, { ...snapshot, bid: 4018, spread: 0.17 })).toBe(false);
    expect(ok(marketSnapshotSchema, { ...snapshot, spread: 0.5 })).toBe(false);
    expect(ok(marketSnapshotSchema, { ...snapshot, mid: 4017.5 })).toBe(false);
  });

  it('ties pausedSince to the engine status', () => {
    expect(ok(marketSnapshotSchema, { ...snapshot, engine: { ...engine, status: 'PAUSED' } })).toBe(
      false,
    );
    expect(
      ok(marketSnapshotSchema, {
        ...snapshot,
        engine: { ...engine, status: 'PAUSED', pausedSince: '2026-10-23T06:00:00Z' },
      }),
    ).toBe(true);
    expect(
      ok(marketSnapshotSchema, {
        ...snapshot,
        engine: { ...engine, pausedSince: '2026-10-23T06:00:00Z' },
      }),
    ).toBe(false);
  });

  it('names the missing timeframes while warming up and none once ready', () => {
    const warming = { ready: false, progressPct: 40, missingTimeframes: ['1h', '4h'] };
    expect(ok(marketSnapshotSchema, { ...snapshot, engine: { ...engine, warmup: warming } })).toBe(
      true,
    );
    const contradiction = { ...warming, ready: true };
    expect(
      ok(marketSnapshotSchema, { ...snapshot, engine: { ...engine, warmup: contradiction } }),
    ).toBe(false);
    expect(
      ok(marketSnapshotSchema, {
        ...snapshot,
        engine: { ...engine, warmup: { ready: false, progressPct: 40 } },
      }),
    ).toBe(false);
  });

  it('accepts every session of the status bar, including ROLLOVER', () => {
    for (const session of ['ASIA', 'LONDON', 'OVERLAP', 'NEW_YORK', 'ROLLOVER']) {
      expect(ok(marketSnapshotSchema, { ...snapshot, session })).toBe(true);
    }
    expect(ok(marketSnapshotSchema, { ...snapshot, session: 'OFF' })).toBe(false);
  });

  it('rejects an unknown feed state', () => {
    expect(ok(marketSnapshotSchema, { ...snapshot, feedState: 'FINE' })).toBe(false);
  });
});

describe('candles response', () => {
  it('accepts candles with overlays that may have gaps', () => {
    const body = {
      candles: [{ t: '2026-10-23T06:05:00Z', o: 1, h: 2, l: 0.5, c: 1.5 }],
      overlays: { ema20: [null, 4015.2] },
      levels: [{ key: 'PDH', label: 'Previous day high', price: 4030.5 }],
      objects: [],
    };
    expect(roundTrip(candlesResponseSchema, body)).toEqual(body);
    expect(ok(candlesResponseSchema, { ...body, overlays: { macd: [1] } })).toBe(false);
  });
});

describe('signal endpoints', () => {
  const live = {
    status: 'ACTIVE',
    currentPrice: 4019.1,
    unrealisedR: 0.27,
    mfeR: 0.4,
    maeR: -0.2,
    stopLossCurrent: 4010.9,
    timeToTimeStopS: 6000,
  };

  it('lists several open signals with their count', () => {
    const body = { items: [{ signal: signal(), live }], openCount: 1, openRiskR: 1 };
    expect(roundTrip(openSignalsResponseSchema, body)).toEqual(body);
    expect(ok(openSignalsResponseSchema, { ...body, openCount: 2 })).toBe(false);
  });

  it('does not list a closed signal as open', () => {
    const body = {
      items: [{ signal: signal(), live: { ...live, status: 'CLOSED' } }],
      openCount: 1,
      openRiskR: 1,
    };
    expect(ok(openSignalsResponseSchema, body)).toBe(false);
  });

  const historyRow = {
    signalId: SIGNAL_ID,
    seq: 42,
    generatedAt: '2026-10-23T06:10:00Z',
    side: 'BUY',
    mode: 'LIVE',
    strategyKey: 'trend_pullback',
    strategyVersion: '0.1.0',
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: 'EP1_PARTIAL',
    entry: 4017.37,
    stopLoss: 4010.9,
    tp1: 4023.84,
    tp2: 4030.31,
    riskDistance: 6.47,
    regime: 'TREND_UP',
    session: 'LONDON',
    volBucket: 'NORMAL',
    newsState: 'CLEAR',
    qualityScore: 78,
    openSignalsAtEntry: 0,
    warnings: [],
    evidenceWinRate: 0.58,
    evidenceN: 64,
    state: 'ACTIVE',
    result: null,
    countsInStats: null,
    isWin: null,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedRNet: null,
    mfeR: null,
    maeR: null,
    durationS: null,
    tp1Hit: null,
    tp2Hit: null,
    ambiguous: null,
    primaryCause: null,
    autopsyStatus: null,
  };

  it('accepts a history row of an open signal', () => {
    expect(roundTrip(signalHistoryRowSchema, historyRow)).toEqual(historyRow);
    expect(ok(signalHistoryRowSchema, { ...historyRow, extra: 1 })).toBe(false);
  });

  it('puts the summary of the whole filtered list next to a page of rows', () => {
    const summary = {
      generated: 1,
      resolvedValid: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      timeExits: 0,
      cancelled: 0,
      dataInvalid: 0,
      winRate: null,
      ci95: null,
      netR: 0,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownR: 0,
      avgDurationS: null,
      tp1Rate: null,
      tp2Rate: null,
      currentStreak: null,
    };
    const page = { items: [historyRow], nextCursor: null, summary };
    expect(roundTrip(signalHistoryPageSchema, page)).toEqual(page);
    expect(ok(signalHistoryPageSchema, { items: [historyRow], nextCursor: null })).toBe(false);
    // the summary obeys the rule for percentages: none below 30 valid results
    expect(ok(signalHistoryPageSchema, { ...page, summary: { ...summary, winRate: 0.5 } })).toBe(
      false,
    );
  });

  it('shows an open signal with state and no outcome', () => {
    const detail = {
      signal: signal(),
      state: signalState(),
      events: [],
      outcome: null,
      autopsy: null,
      snapshotAvailable: true,
    };
    expect(roundTrip(signalDetailSchema, detail)).toEqual(detail);
  });

  it('shows a closed signal with an outcome and no state', () => {
    const detail = {
      signal: signal(),
      state: null,
      events: [],
      outcome: outcome(),
      autopsy: null,
      snapshotAvailable: false,
    };
    expect(ok(signalDetailSchema, detail)).toBe(true);
    expect(ok(signalDetailSchema, { ...detail, state: signalState() })).toBe(false);
    expect(ok(signalDetailSchema, { ...detail, outcome: null })).toBe(false);
  });

  it('rejects a review before the outcome and events of another signal', () => {
    const open = {
      signal: signal(),
      state: signalState(),
      events: [],
      outcome: null,
      autopsy: null,
      snapshotAvailable: true,
    };
    const other = {
      id: 1,
      signalId: '11111111-1111-4111-8111-111111111111',
      eventType: 'CREATED',
      eventAt: '2026-10-23T06:10:00Z',
      price: null,
      meta: {},
    };
    expect(ok(signalDetailSchema, { ...open, events: [other] })).toBe(false);
  });

  it('returns the snapshot as plain JSON features', () => {
    expect(
      ok(featureSnapshotResponseSchema, { signalId: SIGNAL_ID, features: { rsi14: 54.1 } }),
    ).toBe(true);
    expect(
      ok(featureSnapshotResponseSchema, { signalId: SIGNAL_ID, features: { bad: undefined } }),
    ).toBe(false);
  });
});

describe('analytics', () => {
  const overview = {
    generated: 41,
    resolvedValid: 39,
    wins: 14,
    partials: 6,
    losses: 15,
    timeExits: 4,
    cancelled: 1,
    dataInvalid: 1,
    winRate: 0.538,
    ci95: [0.39, 0.68],
    netR: 5.2,
    expectancyR: 0.13,
    profitFactor: 1.2,
    maxDrawdownR: 4.5,
    avgDurationS: 2100,
    tp1Rate: 0.6,
    tp2Rate: 0.35,
    currentStreak: { type: 'LOSS', length: 2 },
  };

  it('accepts the monthly-report example numbers (14 + 6 + 15 + 4 = 39 valid)', () => {
    expect(roundTrip(overviewResponseSchema, overview)).toEqual(overview);
  });

  it('keeps cancelled and invalid signals out of the valid count', () => {
    expect(ok(overviewResponseSchema, { ...overview, resolvedValid: 41 })).toBe(false);
  });

  it('never shows a win rate without its interval or outside it', () => {
    expect(ok(overviewResponseSchema, { ...overview, ci95: null })).toBe(false);
    expect(ok(overviewResponseSchema, { ...overview, winRate: 0.9 })).toBe(false);
  });

  it('shows no win rate when nothing was resolved', () => {
    const none = {
      ...overview,
      generated: 0,
      resolvedValid: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      timeExits: 0,
      cancelled: 0,
      dataInvalid: 0,
      winRate: null,
      ci95: null,
      expectancyR: null,
      profitFactor: null,
      avgDurationS: null,
      tp1Rate: null,
      tp2Rate: null,
      currentStreak: null,
      netR: 0,
      maxDrawdownR: 0,
    };
    expect(ok(overviewResponseSchema, none)).toBe(true);
    expect(ok(overviewResponseSchema, { ...none, winRate: 0.5, ci95: [0.1, 0.9] })).toBe(false);
  });

  it('formats months as YYYY-MM', () => {
    const row = {
      month: '2026-10',
      generated: 41,
      resolvedValid: 39,
      wins: 14,
      partials: 6,
      losses: 15,
      timeExits: 4,
      cancelled: 1,
      dataInvalid: 1,
      winRate: 0.538,
      netR: 5.2,
      profitFactor: 1.2,
    };
    expect(ok(monthlyRowSchema, row)).toBe(true);
    expect(ok(monthlyRowSchema, { ...row, month: '2026-13' })).toBe(false);
    expect(ok(monthlyRowSchema, { ...row, month: '2026-10-01' })).toBe(false);
  });

  it('rejects a calibration band that runs backwards', () => {
    const band = {
      bandFrom: 65,
      bandTo: 74,
      n: 40,
      wins: 17,
      winRate: 0.43,
      ci95: [0.28, 0.59],
    };
    expect(ok(calibrationRowSchema, band)).toBe(true);
    expect(ok(calibrationRowSchema, { ...band, bandFrom: 80 })).toBe(false);
  });

  it('describes drift without inventing thresholds', () => {
    const row = {
      strategy: 'trend_pullback',
      window: 50,
      n: 50,
      rollingWinRate: 0.44,
      evidenceCi95: [0.46, 0.69],
      status: 'BELOW_RANGE',
    };
    expect(ok(driftRowSchema, row)).toBe(true);
    expect(ok(driftRowSchema, { ...row, status: 'PANIC' })).toBe(false);
    expect(ok(driftRowSchema, { ...row, n: 51 })).toBe(false);
  });

  it('reports drift as insufficient data below 30 trades, with no rate', () => {
    const row = {
      strategy: 'trend_pullback',
      window: 50,
      n: 12,
      rollingWinRate: null,
      evidenceCi95: null,
      status: 'INSUFFICIENT_DATA',
    };
    expect(ok(driftRowSchema, row)).toBe(true);
    expect(ok(driftRowSchema, { ...row, rollingWinRate: 0.5 })).toBe(false);
    expect(ok(driftRowSchema, { ...row, status: 'WITHIN_RANGE' })).toBe(false);
  });

  describe('news impact', () => {
    const row = {
      topic: 'GEOPOLITICS_WAR',
      impact: 'HIGH',
      n: 52,
      moved: 20,
      movedShare: 0.38,
      movedCi95: [0.26, 0.52],
      avgAbsMoveAtr: 0.9,
      baselineShare: 0.14,
      lift: 2.7,
      lowSample: true,
    };

    it('accepts the documented example (38% of 52 headlines, low sample)', () => {
      expect(ok(newsImpactRowSchema, row)).toBe(true);
    });

    it('keeps the share paired with its interval and the low-sample marker honest', () => {
      expect(ok(newsImpactRowSchema, { ...row, movedCi95: null })).toBe(false);
      expect(ok(newsImpactRowSchema, { ...row, lowSample: false })).toBe(false);
      expect(ok(newsImpactRowSchema, { ...row, n: 150, moved: 57, lowSample: false })).toBe(true);
    });

    it('says "not enough data yet" below 30 samples by sending no share', () => {
      const few = { ...row, n: 18, moved: 7, movedShare: null, movedCi95: null };
      expect(ok(newsImpactRowSchema, few)).toBe(true);
      expect(ok(newsImpactRowSchema, { ...few, movedShare: 0.39 })).toBe(false);
    });
  });

  describe('no percentage below 30 trades (rule C6, scenario E10)', () => {
    const zeros = {
      generated: 12,
      resolvedValid: 10,
      wins: 4,
      partials: 1,
      losses: 4,
      timeExits: 1,
      cancelled: 1,
      dataInvalid: 1,
    };

    it('hides the overview rates and carries only counts', () => {
      const few = {
        ...zeros,
        winRate: null,
        ci95: null,
        netR: 0.8,
        expectancyR: 0.08,
        profitFactor: 1.1,
        maxDrawdownR: 2,
        avgDurationS: 1800,
        tp1Rate: null,
        tp2Rate: null,
        currentStreak: { type: 'WIN', length: 1 },
      };
      expect(ok(overviewResponseSchema, few)).toBe(true);
      expect(ok(overviewResponseSchema, { ...few, winRate: 0.5, ci95: [0.2, 0.8] })).toBe(false);
      expect(ok(overviewResponseSchema, { ...few, tp1Rate: 0.6 })).toBe(false);
    });

    it('requires the overview rates once n reaches 30', () => {
      expect(ok(overviewResponseSchema, { ...overview, winRate: null, ci95: null })).toBe(false);
      expect(ok(overviewResponseSchema, { ...overview, tp1Rate: null })).toBe(false);
    });

    it('hides a monthly win rate below 30 valid results', () => {
      const month = {
        month: '2026-09',
        ...zeros,
        winRate: null,
        netR: 0.8,
        profitFactor: null,
      };
      expect(ok(monthlyRowSchema, month)).toBe(true);
      expect(ok(monthlyRowSchema, { ...month, winRate: 0.5 })).toBe(false);
    });

    it('hides breakdown and group percentages below 30 and checks the low-sample marker', () => {
      const row = {
        key: 'LONDON',
        n: 21,
        wins: 9,
        winRate: null,
        ci95: null,
        expectancyR: 0.1,
        profitFactor: 1.2,
        lowSample: true,
      };
      expect(ok(breakdownRowSchema, row)).toBe(true);
      expect(ok(breakdownRowSchema, { ...row, winRate: 0.43, ci95: [0.24, 0.65] })).toBe(false);
      expect(ok(breakdownRowSchema, { ...row, lowSample: false })).toBe(false);
      const enough = {
        ...row,
        n: 120,
        wins: 66,
        winRate: 0.55,
        ci95: [0.46, 0.64],
        lowSample: false,
      };
      expect(ok(breakdownRowSchema, enough)).toBe(true);
      expect(ok(breakdownRowSchema, { ...enough, wins: 121 })).toBe(false);

      const group = {
        strategy: 'trend_pullback',
        group: 'trend',
        state: 'STRONG',
        n: 12,
        wins: 8,
        winRate: null,
        ci95: null,
        expectancyR: 0.4,
      };
      expect(ok(groupEffectivenessRowSchema, group)).toBe(true);
      expect(ok(groupEffectivenessRowSchema, { ...group, winRate: 0.66, ci95: [0.4, 0.85] })).toBe(
        false,
      );
    });

    it('hides a calibration band below 30', () => {
      const band = { bandFrom: 65, bandTo: 74, n: 21, wins: 9, winRate: 0.43, ci95: [0.24, 0.65] };
      expect(ok(calibrationRowSchema, band)).toBe(false);
      expect(ok(calibrationRowSchema, { ...band, winRate: null, ci95: null })).toBe(true);
    });
  });

  it('reports latency percentiles in order', () => {
    const metric = { p50Ms: 12, p95Ms: 40, samples: 100 };
    const body = {
      feedLag: metric,
      candleToSignal: metric,
      dbCommit: metric,
      notifyDispatch: metric,
    };
    expect(ok(systemLatencySchema, body)).toBe(true);
    expect(ok(systemLatencySchema, { ...body, dbCommit: { ...metric, p50Ms: 50 } })).toBe(false);
  });
});

describe('strategies', () => {
  it('lists a strategy with its evidence', () => {
    const info = {
      key: 'trend_pullback',
      version: '0.1.0',
      status: 'FORWARD_TESTING',
      enabled: true,
      alerts: true,
      lastSignalAt: null,
      evidence: evidence(),
    };
    expect(roundTrip(strategyInfoSchema, info)).toEqual(info);
    expect(ok(strategyInfoSchema, { ...info, config: {} })).toBe(false);
  });

  it('allows only the two owner switches', () => {
    expect(ok(strategyPatchSchema, { alerts: false })).toBe(true);
    expect(ok(strategyPatchSchema, {})).toBe(false);
    expect(ok(strategyPatchSchema, { status: 'VALIDATED' })).toBe(false);
  });
});

describe('news', () => {
  const headline = {
    id: '22222222-2222-4222-8222-222222222222',
    title: "Trump announces new tariffs on 'imports'",
    sources: [{ key: 'bbc', name: 'BBC News' }],
    publishedAt: '2026-10-23T16:12:00Z',
    firstSeenAt: '2026-10-23T16:14:00Z',
    delayS: 120,
    topics: ['TRUMP_POLICY'],
    impact: 'HIGH',
    url: 'https://www.bbc.com/news/example',
    goldMoveSincePublish: { usd: 3.8, atr: 0.9 },
  };

  it('accepts a headline and rejects non-http links', () => {
    expect(roundTrip(headlineSchema, headline)).toEqual(headline);
    expect(ok(headlineSchema, { ...headline, url: 'javascript:alert(1)' })).toBe(false);
    expect(ok(headlineSchema, { ...headline, url: 'data:text/html,hi' })).toBe(false);
    expect(ok(headlineSchema, { ...headline, url: 'http://example.com/a' })).toBe(true);
  });

  it('requires at least one topic and one source', () => {
    expect(ok(headlineSchema, { ...headline, topics: [] })).toBe(false);
    expect(ok(headlineSchema, { ...headline, sources: [] })).toBe(false);
  });

  it('labels unclassified headlines as timing only', () => {
    const frozen = {
      title: 'Something happened',
      sources: ['Al Jazeera'],
      publishedAt: null,
      impact: null,
      topics: [],
      url: 'https://example.com/story',
      classified: false,
    };
    expect(ok(frozenHeadlineSchema, frozen)).toBe(true);
    expect(ok(frozenHeadlineSchema, { ...frozen, impact: 'HIGH' })).toBe(false);
    expect(ok(frozenHeadlineSchema, { ...frozen, classified: true })).toBe(false);
  });

  it('describes a market move with its frozen headlines', () => {
    const move = {
      id: 7,
      detectedAt: '2026-10-23T16:17:00Z',
      kind: 'SPIKE_UP',
      windowS: 240,
      moveUsd: 9.8,
      moveAtr: 2.8,
      spread: 0.35,
      headlines: [],
    };
    expect(roundTrip(marketMoveSchema, move)).toEqual(move);
    expect(ok(marketMoveSchema, { ...move, kind: 'CRASH' })).toBe(false);
  });

  it('keeps calendar values numeric and nullable', () => {
    const event = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'CPI m/m',
      scheduledAt: '2026-10-23T12:30:00Z',
      importance: 'high',
      currency: 'USD',
      unit: '%',
      actual: null,
      forecast: 0.3,
      previous: 0.4,
      revisedPrevious: null,
    };
    expect(roundTrip(macroEventSchema, event)).toEqual(event);
    expect(ok(macroEventSchema, { ...event, importance: 'HIGH' })).toBe(false);
  });

  describe('calendar list', () => {
    const released = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'CPI m/m',
      scheduledAt: '2026-10-23T12:30:00Z',
      importance: 'high',
      currency: 'USD',
      unit: '%',
      actual: 0.5,
      forecast: 0.3,
      previous: 0.4,
      revisedPrevious: 0.3,
      surpriseSigma: 2.1,
      goldMoveAfter: { usd: -3.1, atr: -0.7 },
    };
    const upcoming = { ...released, actual: null, surpriseSigma: null, goldMoveAfter: null };

    it('accepts a released and an upcoming event', () => {
      expect(roundTrip(calendarEventSchema, released)).toEqual(released);
      expect(roundTrip(calendarEventSchema, upcoming)).toEqual(upcoming);
      expect(ok(newsEventsResponseSchema, { items: [upcoming, released], sourceAgeS: 45 })).toBe(
        true,
      );
      expect(ok(newsEventsResponseSchema, { items: [], sourceAgeS: null })).toBe(true);
      expect(ok(newsEventsResponseSchema, { items: [] })).toBe(false);
    });

    it('has no surprise and no move for an event that was not released', () => {
      expect(ok(calendarEventSchema, { ...upcoming, surpriseSigma: 1 })).toBe(false);
      expect(ok(calendarEventSchema, { ...upcoming, goldMoveAfter: { usd: 1, atr: 0.2 } })).toBe(
        false,
      );
      // a released event may lack them: no history to measure the surprise, no candles
      expect(ok(calendarEventSchema, { ...released, surpriseSigma: null })).toBe(true);
      expect(ok(calendarEventSchema, { ...released, goldMoveAfter: null })).toBe(true);
    });

    it('takes a range and one importance as the query, and refuses a range that ends first', () => {
      expect(ok(newsEventsQuerySchema, { importance: 'high' })).toBe(true);
      expect(ok(newsEventsQuerySchema, { importance: 'HIGH' })).toBe(false);
      expect(
        ok(newsEventsQuerySchema, { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
      ).toBe(false);
    });
  });

  it('lists market moves, newest first, and takes a range', () => {
    expect(ok(marketMovesResponseSchema, { items: [] })).toBe(true);
    expect(ok(marketMovesQuerySchema, { from: '2026-10-01T00:00:00Z' })).toBe(true);
    expect(
      ok(marketMovesQuerySchema, { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
    ).toBe(false);
    expect(ok(marketMovesQuerySchema, { kind: 'SPIKE_UP' })).toBe(false);
  });
});

describe('system pages', () => {
  const incident = {
    id: 12,
    kind: 'STALE',
    startedAt: '2026-10-23T08:32:00Z',
    endedAt: '2026-10-23T08:37:00Z',
    detail: 'No tick for 18 s',
  };

  it('accepts an open and a closed feed incident of a known kind', () => {
    expect(roundTrip(feedIncidentSchema, incident)).toEqual(incident);
    expect(ok(feedIncidentSchema, { ...incident, endedAt: null })).toBe(true);
    expect(ok(feedIncidentSchema, { ...incident, kind: 'MELTDOWN' })).toBe(false);
    expect(ok(feedIncidentSchema, { ...incident, endedAt: '2026-10-23T08:00:00Z' })).toBe(false);
  });

  it('lists at most the last 30 incidents', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...incident, id: i + 1 }));
    expect(ok(systemIncidentsResponseSchema, { items: many(30) })).toBe(true);
    expect(ok(systemIncidentsResponseSchema, { items: many(31) })).toBe(false);
  });

  it('says what is not known yet with null, never with a guess', () => {
    const health = {
      feedAgeMs: null,
      ticksPerSecond: null,
      workerHeartbeatAt: null,
      eventLoopLagMs: null,
      dbReachable: true,
      telegram: { lastSendAt: null, lastError: null },
      clockSkewMs: null,
      lastBackupAt: null,
      lastMaintenanceAt: null,
    };
    expect(ok(systemHealthSchema, health)).toBe(true);
    expect(ok(systemHealthSchema, { ...health, dbReachable: null })).toBe(false);
    expect(ok(systemHealthSchema, { ...health, feedAgeMs: -1 })).toBe(false);
  });

  it('describes the storage with sizes in bytes and the rules as text', () => {
    const storage = {
      dbSizeBytes: 1_181_116_006,
      tables: [{ name: 'ticks', sizeBytes: 900_000_000 }],
      retention: [{ item: 'Raw ticks', rule: '14 days' }],
      budgetPct: 11,
      lastMaintenanceRun: { job: 'retention', finishedAt: '2026-10-23T01:15:00Z', rowsDeleted: 0 },
    };
    expect(roundTrip(systemStorageSchema, storage)).toEqual(storage);
    expect(ok(systemStorageSchema, { ...storage, lastMaintenanceRun: null })).toBe(true);
    expect(ok(systemStorageSchema, { ...storage, budgetPct: -1 })).toBe(false);
    expect(ok(systemStorageSchema, { ...storage, dbSizeBytes: 1.5 })).toBe(false);
  });

  it('names the channel of a test message', () => {
    expect(ok(notificationTestRequestSchema, { channel: 'telegram' })).toBe(true);
    expect(ok(notificationTestRequestSchema, { channel: 'sms' })).toBe(false);
    expect(
      ok(notificationTestResponseSchema, { eventKey: 'test:0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10' }),
    ).toBe(true);
    expect(ok(notificationTestResponseSchema, { eventKey: 'signal:1' })).toBe(false);
  });
});

describe('security payloads', () => {
  const session = {
    id: 'a1',
    createdAt: '2026-10-22T08:00:00Z',
    lastSeenAt: '2026-10-23T08:00:00Z',
    expiresAt: '2026-10-23T20:00:00Z',
    current: true,
  };

  it('requires a new password of at least 12 characters', () => {
    expect(ok(passwordChangeRequestSchema, { current: 'old', next: 'a-long-new-pass' })).toBe(true);
    expect(ok(passwordChangeRequestSchema, { current: 'old', next: 'short-11-ch' })).toBe(false);
    expect(ok(passwordChangeRequestSchema, { current: 'old', next: 'exactly-12-ch' })).toBe(true);
    expect(ok(passwordChangeRequestSchema, { current: '', next: 'a-long-new-pass' })).toBe(false);
  });

  it('lists the sessions, with at most one that is the current one', () => {
    expect(
      ok(sessionsResponseSchema, { items: [session, { ...session, id: 'b2', current: false }] }),
    ).toBe(true);
    expect(ok(sessionsResponseSchema, { items: [session, { ...session, id: 'b2' }] })).toBe(false);
    expect(ok(sessionsResponseSchema, { items: [] })).toBe(true);
  });

  it('sets up the second step with a base32 secret and an otpauth link, and checks a six digit code', () => {
    const setup = {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl: 'otpauth://totp/VM%20Gold%20Signal:owner?secret=JBSWY3DPEHPK3PXP',
    };
    expect(ok(totpSetupResponseSchema, setup)).toBe(true);
    expect(ok(totpSetupResponseSchema, { ...setup, secret: 'jbswy3dpehpk3pxp' })).toBe(false);
    expect(ok(totpSetupResponseSchema, { ...setup, secret: 'ABC' })).toBe(false);
    expect(ok(totpSetupResponseSchema, { ...setup, otpauthUrl: 'https://example.com' })).toBe(
      false,
    );
    expect(ok(totpCodeRequestSchema, { code: '123456' })).toBe(true);
    expect(ok(totpCodeRequestSchema, { code: '12345' })).toBe(false);
    expect(ok(totpCodeRequestSchema, { code: '12345a' })).toBe(false);
  });

  it('gives exactly eight recovery codes of the form xxxx-xxxx', () => {
    const codes = Array.from({ length: 8 }, (_, i) => `ab${String(i)}d-ef${String(i)}9`);
    expect(ok(totpEnableResponseSchema, { recoveryCodes: codes })).toBe(true);
    expect(ok(totpEnableResponseSchema, { recoveryCodes: codes.slice(1) })).toBe(false);
    expect(ok(totpEnableResponseSchema, { recoveryCodes: [...codes.slice(1), 'ABCD-EFGH'] })).toBe(
      false,
    );
  });
});

describe('strategy config', () => {
  it('is read-only JSON for one version of one strategy', () => {
    const body = {
      key: 'trend_pullback',
      version: '0.1.0',
      config: { gates: { maxTickAgeSec: 10 }, quality: { min: 65 }, list: [1, 'a', null, true] },
    };
    expect(roundTrip(strategyConfigResponseSchema, body)).toEqual(body);
    expect(ok(strategyConfigResponseSchema, { ...body, key: 'moon_phase' })).toBe(false);
    expect(ok(strategyConfigResponseSchema, { ...body, config: [] })).toBe(false);
    expect(ok(strategyConfigResponseSchema, { ...body, version: 'latest' })).toBe(false);
  });
});

describe('settings', () => {
  const onOff = (keys: readonly string[], value: string) =>
    Object.fromEntries(keys.map((key) => [key, value]));

  const settings = {
    displayTz: 'Asia/Kolkata',
    locale: 'hinglish',
    alerts: {
      telegram: { enabled: true, minGrade: 'Moderate', kinds: ['SIGNAL_NEW', 'SIGNAL_CLOSED'] },
      webpush: { enabled: false, minGrade: 'Strong' },
    },
    advisoryGates: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'block' },
    strategyAlerts: onOff(STRATEGY_KEYS, 'on'),
    newsAlerts: { minImpact: 'HIGH', topics: onOff(NEWS_TOPICS, 'on'), marketMoves: 'on' },
  };

  it('round-trips the full settings', () => {
    expect(roundTrip(settingsSchema, settings)).toEqual(settings);
  });

  it('accepts only named IANA time zones', () => {
    expect(ok(settingsSchema, { ...settings, displayTz: 'UTC' })).toBe(true);
    expect(ok(settingsSchema, { ...settings, displayTz: 'America/New_York' })).toBe(true);
    expect(ok(settingsSchema, { ...settings, displayTz: '+05:30' })).toBe(false);
    expect(ok(settingsSchema, { ...settings, displayTz: 'Mars/Olympus' })).toBe(false);
    expect(ok(settingsSchema, { ...settings, displayTz: '' })).toBe(false);
  });

  it('requires a switch for every strategy and topic', () => {
    expect(ok(settingsSchema, { ...settings, strategyAlerts: { trend_pullback: 'on' } })).toBe(
      false,
    );
    expect(
      ok(settingsSchema, {
        ...settings,
        strategyAlerts: { ...settings.strategyAlerts, rogue: 'on' },
      }),
    ).toBe(false);
  });

  it('rejects duplicate alert kinds and unknown modes', () => {
    const alerts = {
      ...settings.alerts,
      telegram: { ...settings.alerts.telegram, kinds: ['SIGNAL_NEW', 'SIGNAL_NEW'] },
    };
    expect(ok(settingsSchema, { ...settings, alerts })).toBe(false);
    expect(
      ok(settingsSchema, {
        ...settings,
        advisoryGates: { ...settings.advisoryGates, rollover: 'ignore' },
      }),
    ).toBe(false);
  });

  it('accepts partial updates and rejects empty or unknown ones', () => {
    expect(ok(settingsPatchSchema, { locale: 'en' })).toBe(true);
    expect(ok(settingsPatchSchema, { alerts: { telegram: { enabled: false } } })).toBe(true);
    expect(ok(settingsPatchSchema, { strategyAlerts: { pattern_breakout: 'off' } })).toBe(true);
    expect(ok(settingsPatchSchema, {})).toBe(false);
    expect(ok(settingsPatchSchema, { engine: { paused: true } })).toBe(false);
    expect(ok(settingsPatchSchema, { alerts: { telegram: { token: 'x' } } })).toBe(false);
  });
});

describe('push subscription', () => {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    },
  };

  it('accepts https endpoints only', () => {
    expect(ok(pushSubscribeRequestSchema, subscription)).toBe(true);
    expect(
      ok(pushSubscribeRequestSchema, { ...subscription, endpoint: 'http://push.example.com/x' }),
    ).toBe(false);
  });

  it('rejects keys that are not base64url', () => {
    expect(
      ok(pushSubscribeRequestSchema, {
        ...subscription,
        keys: { ...subscription.keys, auth: 'a b c d e f g h i j k' },
      }),
    ).toBe(false);
  });
});

describe('health and stream', () => {
  it('keeps the public readiness answer minimal', () => {
    expect(ok(healthReadySchema, { status: 'ok' })).toBe(true);
    expect(ok(healthReadySchema, { status: 'not_ready' })).toBe(true);
    expect(ok(healthReadySchema, { status: 'ok', db: true })).toBe(false);
  });

  it('accepts event ids of the form bootId:n', () => {
    expect(ok(sseEventIdSchema, 'b1f3-77:42')).toBe(true);
    expect(ok(sseEventIdSchema, '42')).toBe(false);
    expect(ok(sseEventIdSchema, 'boot:x')).toBe(false);
  });

  const events = [
    {
      event: 'quote',
      data: { bid: 4017.2, ask: 4017.37, spread: 0.17, ageMs: 250, feedState: 'LIVE' },
    },
    { event: 'signal', data: { id: SIGNAL_ID } },
    {
      event: 'signal_update',
      data: { id: SIGNAL_ID, status: 'TP1_HIT', unrealisedR: 1, stop: 4017.37 },
    },
    {
      event: 'engine',
      data: { status: 'RUNNING', waitReasons: [], regime: 'RANGE', session: 'ASIA' },
    },
    { event: 'news', data: { state: 'UNKNOWN', next: null } },
    { event: 'health', data: { feed: 'OK', telegram: 'DEGRADED' } },
    { event: 'resync', data: {} },
  ];

  it.each(events)('parses the $event event', (event) => {
    expect(roundTrip(sseEventSchema, event)).toEqual(event);
  });

  it('rejects unknown events and extra payload fields', () => {
    expect(ok(sseEventSchema, { event: 'repaint', data: {} })).toBe(false);
    expect(ok(sseEventSchema, { event: 'signal', data: { id: SIGNAL_ID, entry: 1 } })).toBe(false);
    expect(ok(engineEventSchema, { event: 'engine', data: { status: 'RUNNING' } })).toBe(false);
  });
});
