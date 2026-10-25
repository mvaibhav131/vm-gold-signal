import { describe, expect, it } from 'vitest';

import { BASE, contextOf, decideNow, engineAt, pullbackSpec } from './test-data';
import { ENGINE_STATE_MAX_AGE_MS, engineStateOf } from './state';

const TRIGGER = 53;
const decision = (change: Parameters<typeof decideNow>[1] = {}) =>
  decideNow(engineAt(BASE, [pullbackSpec()], TRIGGER), change);

describe('engineStateOf', () => {
  it('is the regime, the session, the news state and the ATR of the decision, stamped with the close of the candle', () => {
    const { report } = decision();
    const state = engineStateOf(report, ['5m', '15m', '1h'], { '5m': 1, '15m': 1, '1h': 1 });
    expect(state).toMatchObject({
      evaluatedAt: (BASE.five[TRIGGER]?.openTime ?? 0) + 300_000,
      regime: report.regime,
      volBucket: report.volBucket,
      session: 'OVERLAP',
      newsState: 'CLEAR',
      atr5: report.atr5,
      waitReasons: [],
    });
    expect(state.evaluatedAt).toBe(report.decidedAt);
    expect(state.atr5).toBeGreaterThan(0);
  });

  it('says how far the warm-up is, over the timeframes that the strategies need', () => {
    const { report } = decision();
    const counts = report.counts;
    const twice = { '5m': counts['5m'] * 2, '15m': counts['15m'] * 2, '1h': counts['1h'] * 2 };
    expect(engineStateOf(report, ['5m', '15m', '1h'], twice).warmup).toEqual({
      ready: false,
      progressPct: 50,
      missingTimeframes: ['5m', '15m', '1h'],
    });
    expect(engineStateOf(report, ['5m'], { ...twice, '5m': counts['5m'] }).warmup).toEqual({
      ready: true,
      progressPct: 100,
      missingTimeframes: [],
    });
  });

  it('gives one wait reason per failed market gate, with its code', () => {
    const feed = { ...contextOf(0).feed, tickAgeMs: 30_000 };
    const { report } = decision({ feed, clockSkewMs: 9_000 });
    const state = engineStateOf(report, ['5m', '15m', '1h'], { '5m': 1, '15m': 1, '1h': 1 });
    expect(state.waitReasons.map((reason) => reason.code)).toEqual(['DATA_FRESH', 'CLOCK_OK']);
    for (const reason of state.waitReasons) expect(reason.label.length).toBeGreaterThan(5);
  });

  it('is shown for twelve hours', () => {
    expect(ENGINE_STATE_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
  });
});
