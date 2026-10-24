import { describe, expect, it } from 'vitest';

import { GATE_CODES } from '../domain';
import {
  clockGate,
  dataFreshGate,
  evaluateGates,
  gapRecoveryGate,
  qualityGate,
  regimeGate,
  spreadGate,
  stopGate,
  storedGates,
  targetGate,
  warmupGate,
  warmupProgress,
} from './blocking';
import { FEED_OK, FIVE_MINUTES, MARKET_OK, NOW, SETUP_OK, openTimes } from './test-data';
import { GATE_DEFAULTS, type GateParams } from './types';

describe('DATA_FRESH', () => {
  it('passes with a connected feed, a tick of 10 s or less, no stale flag and an open market', () => {
    expect(dataFreshGate(FEED_OK)).toEqual({
      code: 'DATA_FRESH',
      passed: true,
      value: 2,
      limit: 10,
    });
  });

  it('a tick of exactly 10 s still passes, one millisecond more does not', () => {
    expect(dataFreshGate({ ...FEED_OK, tickAgeMs: 10_000 }).passed).toBe(true);
    expect(dataFreshGate({ ...FEED_OK, tickAgeMs: 10_001 })).toEqual({
      code: 'DATA_FRESH',
      passed: false,
      value: 10.001,
      limit: 10,
      reason: 'STALE',
    });
  });

  it('fails when the feed is disconnected, however fresh the last tick was', () => {
    expect(dataFreshGate({ ...FEED_OK, connected: false })).toMatchObject({
      passed: false,
      reason: 'DISCONNECTED',
      value: 2,
    });
  });

  it('fails when there has been no tick at all, with no value', () => {
    const result = dataFreshGate({ ...FEED_OK, tickAgeMs: null });
    expect(result).toEqual({ code: 'DATA_FRESH', passed: false, limit: 10, reason: 'NO_TICK' });
    expect(dataFreshGate({ ...FEED_OK, tickAgeMs: null, connected: false }).reason).toBe(
      'DISCONNECTED',
    );
  });

  it('fails when the provider calls its quote stale, and passes when it does not know', () => {
    expect(dataFreshGate({ ...FEED_OK, providerStale: true })).toMatchObject({
      passed: false,
      reason: 'PROVIDER_STALE',
    });
    expect(dataFreshGate({ ...FEED_OK, providerStale: null }).passed).toBe(true);
  });

  it('fails when the market is closed, also with a fresh tick or a lost connection', () => {
    expect(dataFreshGate({ ...FEED_OK, marketState: 'CLOSED' }).reason).toBe('MARKET_CLOSED');
    expect(
      dataFreshGate({ ...FEED_OK, marketState: 'CLOSED', connected: false, tickAgeMs: 90_000 })
        .reason,
    ).toBe('MARKET_CLOSED');
  });

  it('fails when the market state is not known, even with a fresh tick', () => {
    expect(dataFreshGate({ ...FEED_OK, marketState: 'UNKNOWN' })).toMatchObject({
      passed: false,
      reason: 'MARKET_UNKNOWN',
    });
  });

  it('takes the limit from the parameters', () => {
    const feed = { ...FEED_OK, tickAgeMs: 4_000 };
    expect(dataFreshGate(feed, { maxTickAgeSec: 3 }).passed).toBe(false);
    expect(dataFreshGate(feed, { maxTickAgeSec: 4 }).passed).toBe(true);
  });

  it('says why in the order: closed, disconnected, no tick, too old, stale flag', () => {
    const bad = {
      connected: false,
      tickAgeMs: 50_000,
      providerStale: true,
      marketState: 'CLOSED',
    } as const;
    expect(dataFreshGate(bad).reason).toBe('MARKET_CLOSED');
    expect(dataFreshGate({ ...bad, marketState: 'OPEN' }).reason).toBe('DISCONNECTED');
    expect(dataFreshGate({ ...bad, marketState: 'OPEN', connected: true }).reason).toBe('STALE');
    expect(
      dataFreshGate({ ...bad, marketState: 'OPEN', connected: true, tickAgeMs: 1_000 }).reason,
    ).toBe('PROVIDER_STALE');
  });
});

describe('WARMUP_OK', () => {
  const full = { '5m': 900, '15m': 1440, '1h': 600 };
  const needs = ['5m', '15m', '1h'] as const;

  it('passes when every required timeframe has its candles, with a progress of 100', () => {
    expect(warmupGate(full, needs)).toEqual({
      code: 'WARMUP_OK',
      passed: true,
      value: 100,
      limit: 100,
    });
    expect(warmupProgress(full, needs)).toEqual({
      ready: true,
      progressPct: 100,
      missingTimeframes: [],
    });
  });

  it('one candle short on one timeframe fails and names it', () => {
    const result = warmupGate({ ...full, '1h': 599 }, needs);
    expect(result).toMatchObject({ passed: false, missing: ['1h'] });
    expect(warmupGate({ ...full, '5m': 899 }, needs).missing).toEqual(['5m']);
    expect(warmupGate({ ...full, '15m': 1439 }, needs).missing).toEqual(['15m']);
  });

  it('the progress is the average share of the required timeframes, never 100 before it is ready', () => {
    expect(warmupProgress({ '5m': 450, '15m': 0, '1h': 600 }, needs).progressPct).toBe(50);
    expect(warmupProgress({ '5m': 899, '15m': 1440, '1h': 600 }, needs)).toEqual({
      ready: false,
      progressPct: 99,
      missingTimeframes: ['5m'],
    });
    expect(warmupProgress({}, needs)).toEqual({
      ready: false,
      progressPct: 0,
      missingTimeframes: ['5m', '15m', '1h'],
    });
  });

  it('a timeframe with more candles than it needs counts as full, not more', () => {
    expect(warmupProgress({ '5m': 9_000, '15m': 0, '1h': 0 }, needs).progressPct).toBe(33);
  });

  it('only the required timeframes count, each once', () => {
    expect(warmupProgress({ '1h': 600 }, ['1h', '1h']).ready).toBe(true);
    expect(warmupProgress({ '1h': 600, '5m': 0 }, ['1h']).ready).toBe(true);
  });

  it('lists the missing timeframes in the order they were asked for', () => {
    expect(warmupProgress({}, ['1h', '5m']).missingTimeframes).toEqual(['1h', '5m']);
  });

  it('a timeframe that needs no candles is always warm', () => {
    const needed = { '5m': 0, '1h': 10 };
    expect(warmupProgress({ '1h': 10 }, ['5m', '1h'], needed)).toMatchObject({
      ready: true,
      progressPct: 100,
    });
    // and it counts as complete in the progress of the others
    expect(warmupProgress({ '1h': 5 }, ['5m', '1h'], needed).progressPct).toBe(75);
  });

  it('a timeframe named twice counts once in the progress', () => {
    const needed = { '1h': 600, '5m': 900 };
    expect(warmupProgress({ '1h': 300, '5m': 900 }, ['1h', '1h', '5m'], needed).progressPct).toBe(
      75,
    );
  });

  it('does not lose a whole percent to the rounding of a decimal (0.29 x 100 is 28.999...)', () => {
    expect(warmupProgress({ '1h': 290 }, ['1h'], { '1h': 1_000 }).progressPct).toBe(29);
  });

  it('takes the sizes from the parameters', () => {
    expect(warmupGate({ '1h': 5 }, ['1h'], { warmupCandles: { '1h': 5 } }).passed).toBe(true);
    expect(warmupGate({ '1h': 4 }, ['1h'], { warmupCandles: { '1h': 5 } }).passed).toBe(false);
  });

  it('refuses what it cannot judge: no timeframe, or a timeframe with no known size', () => {
    expect(() => warmupProgress(full, [])).toThrow(RangeError);
    expect(() => warmupProgress(full, ['4h'])).toThrow('4h');
  });
});

describe('CLOCK_OK', () => {
  it('passes under 5 s, in either direction, with the skew in seconds', () => {
    expect(clockGate(900)).toEqual({ code: 'CLOCK_OK', passed: true, value: 0.9, limit: 5 });
    expect(clockGate(-4_999)).toMatchObject({ passed: true, value: 4.999 });
  });

  it('fails at exactly 5 s: "under 5 s" is strict', () => {
    expect(clockGate(5_000)).toEqual({ code: 'CLOCK_OK', passed: false, value: 5, limit: 5 });
    expect(clockGate(-5_000).passed).toBe(false);
    expect(clockGate(4_999).passed).toBe(true);
  });

  it('fails while the skew is not known yet: missing data blocks', () => {
    expect(clockGate(null)).toEqual({
      code: 'CLOCK_OK',
      passed: false,
      limit: 5,
      reason: 'UNKNOWN',
    });
  });

  it('takes the limit from the parameters, and refuses a skew that is not a number', () => {
    expect(clockGate(2_500, { maxClockSkewSec: 2 }).passed).toBe(false);
    expect(clockGate(2_500, { maxClockSkewSec: 3 }).passed).toBe(true);
    expect(() => clockGate(Number.NaN)).toThrow(RangeError);
  });
});

describe('SPREAD_OK', () => {
  it('passes when the spread is within 0.60 USD and within 12% of the stop distance', () => {
    expect(spreadGate(0.2, 3)).toEqual({
      code: 'SPREAD_OK',
      passed: true,
      value: 0.2,
      limit: 0.36,
    });
  });

  it('the limit is the smaller of the two: 0.60 USD or 12% of the stop', () => {
    expect(spreadGate(0.5, 10).limit).toBe(0.6);
    expect(spreadGate(0.5, 2).limit).toBe(0.24);
    expect(spreadGate(0.5, null).limit).toBe(0.6);
  });

  it('0.60 USD passes and a thousandth more fails (stop of 5 or more)', () => {
    expect(spreadGate(0.6, 5).passed).toBe(true);
    expect(spreadGate(0.601, 5)).toEqual({
      code: 'SPREAD_OK',
      passed: false,
      value: 0.601,
      limit: 0.6,
    });
  });

  it('12% of the stop passes and a thousandth more fails (stop of 3: 0.36)', () => {
    expect(spreadGate(0.36, 3).passed).toBe(true);
    expect(spreadGate(0.361, 3)).toMatchObject({ passed: false, limit: 0.36 });
  });

  it('without a stop distance only the absolute limit applies', () => {
    expect(spreadGate(0.6, null).passed).toBe(true);
    expect(spreadGate(0.61, null).passed).toBe(false);
  });

  it('fails while the spread is not known', () => {
    expect(spreadGate(null, 3)).toEqual({
      code: 'SPREAD_OK',
      passed: false,
      limit: 0.36,
      reason: 'UNKNOWN',
    });
  });

  it('takes both limits from the parameters', () => {
    expect(spreadGate(0.35, null, { maxSpreadUsd: 0.3, maxSpreadToStop: 0.12 }).passed).toBe(false);
    expect(spreadGate(0.35, 2, { maxSpreadUsd: 0.6, maxSpreadToStop: 0.2 }).passed).toBe(true);
    expect(spreadGate(0.45, 2, { maxSpreadUsd: 0.6, maxSpreadToStop: 0.2 }).passed).toBe(false);
  });

  it('a spread of exactly 0 is valid: it is not a negative spread', () => {
    expect(spreadGate(0, 3)).toEqual({ code: 'SPREAD_OK', passed: true, value: 0, limit: 0.36 });
  });

  it('refuses a spread or a stop distance that makes no sense', () => {
    expect(() => spreadGate(-0.1, 3)).toThrow(RangeError);
    expect(() => spreadGate(Number.NaN, 3)).toThrow(RangeError);
    expect(() => spreadGate(0.2, 0)).toThrow(RangeError);
    expect(() => spreadGate(0.2, -1)).toThrow(RangeError);
    expect(() => spreadGate(0.2, Number.NaN)).toThrow(RangeError);
    expect(() => spreadGate(0.2, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('GAP_RECOVERY_OK', () => {
  it('passes with 12 candles in a row, and reports 12', () => {
    expect(gapRecoveryGate(openTimes(12), GATE_DEFAULTS, NOW)).toEqual({
      code: 'GAP_RECOVERY_OK',
      passed: true,
      value: 12,
      limit: 12,
    });
  });

  it('11 candles in a row are one short', () => {
    expect(gapRecoveryGate(openTimes(11))).toMatchObject({ passed: false, value: 11, limit: 12 });
  });

  it('counts only the candles after the last hole', () => {
    const times = [...openTimes(5, NOW - 20 * FIVE_MINUTES), ...openTimes(8, NOW)];
    expect(gapRecoveryGate(times)).toMatchObject({ passed: false, value: 8 });
    const longer = [...openTimes(5, NOW - 20 * FIVE_MINUTES), ...openTimes(12, NOW)];
    expect(gapRecoveryGate(longer)).toMatchObject({ passed: true, value: 12 });
  });

  it('a single missing candle inside the newest 12 is a hole', () => {
    const times = openTimes(13);
    times.splice(7, 1);
    expect(gapRecoveryGate(times)).toMatchObject({ passed: false, value: 5 });
  });

  it('a hole just before the newest 12 candles does not count', () => {
    const times = [NOW - 100 * FIVE_MINUTES, ...openTimes(12)];
    expect(gapRecoveryGate(times)).toMatchObject({ passed: true, value: 12 });
  });

  it('a weekend is a hole like any other', () => {
    const friday = Date.UTC(2026, 0, 16, 21, 55);
    const sunday = Date.UTC(2026, 0, 18, 22, 0);
    const times = [friday - FIVE_MINUTES, friday, ...openTimes(6, sunday + 5 * FIVE_MINUTES)];
    expect(gapRecoveryGate(times)).toMatchObject({ passed: false, value: 6 });
  });

  it('a long unbroken run still reports the limit, not more', () => {
    expect(gapRecoveryGate(openTimes(300))).toMatchObject({ passed: true, value: 12 });
  });

  it('fails when the candle that has just closed is missing from the end of the series', () => {
    expect(gapRecoveryGate(openTimes(20, NOW - FIVE_MINUTES), GATE_DEFAULTS, NOW)).toEqual({
      code: 'GAP_RECOVERY_OK',
      passed: false,
      value: 0,
      limit: 12,
      reason: 'MISSING_CANDLE',
    });
    expect(gapRecoveryGate(openTimes(20), GATE_DEFAULTS, NOW).passed).toBe(true);
    expect(gapRecoveryGate(openTimes(20), GATE_DEFAULTS, NOW - FIVE_MINUTES).passed).toBe(true);
  });

  it('fails with no candles at all', () => {
    expect(gapRecoveryGate([])).toEqual({
      code: 'GAP_RECOVERY_OK',
      passed: false,
      value: 0,
      limit: 12,
      reason: 'UNKNOWN',
    });
  });

  it('a single candle is a run of one', () => {
    expect(gapRecoveryGate([NOW])).toMatchObject({ passed: false, value: 1 });
    expect(gapRecoveryGate([NOW], { gapRecoveryCandles: 1 }).passed).toBe(true);
  });

  it('takes the number of candles from the parameters', () => {
    expect(gapRecoveryGate(openTimes(5), { gapRecoveryCandles: 6 }).passed).toBe(false);
    expect(gapRecoveryGate(openTimes(6), { gapRecoveryCandles: 6 }).passed).toBe(true);
  });

  it('refuses open times that are not in time order', () => {
    expect(() => gapRecoveryGate([NOW, NOW - FIVE_MINUTES])).toThrow('time order');
    expect(() => gapRecoveryGate([NOW, NOW])).toThrow('time order');
  });
});

describe('REGIME_OK', () => {
  it('passes for a regime the strategy accepts and fails for any other', () => {
    expect(regimeGate('TREND_UP', ['TREND_UP', 'TREND_DOWN'])).toEqual({
      code: 'REGIME_OK',
      passed: true,
    });
    expect(regimeGate('RANGE', ['TREND_UP', 'TREND_DOWN'])).toEqual({
      code: 'REGIME_OK',
      passed: false,
    });
    expect(regimeGate('UNCERTAIN', [])).toMatchObject({ passed: false });
  });
});

describe('STOP_OK', () => {
  it('passes between 0.8 and 2.0 ATR(5m) and reports the distance in ATR', () => {
    expect(stopGate(3, 2)).toEqual({ code: 'STOP_OK', passed: true, value: 1.5, limit: 2 });
  });

  it('0.8 ATR passes, a little less fails and names the lower limit', () => {
    expect(stopGate(1.6, 2).passed).toBe(true);
    expect(stopGate(1.59, 2)).toEqual({ code: 'STOP_OK', passed: false, value: 0.795, limit: 0.8 });
  });

  it('2.0 ATR passes, a little more fails and names the upper limit', () => {
    expect(stopGate(4, 2).passed).toBe(true);
    expect(stopGate(4.02, 2)).toEqual({ code: 'STOP_OK', passed: false, value: 2.01, limit: 2 });
  });

  it('a pass names the limit it is nearest to', () => {
    expect(stopGate(2, 2)).toMatchObject({ value: 1, limit: 0.8 });
    expect(stopGate(3, 2)).toMatchObject({ value: 1.5, limit: 2 });
  });

  it('does not fail a distance that is 0.8 ATR except for the last bit of a decimal', () => {
    // 0.8 x 0.7 is 0.5599999999999999, and over 0.7 that is 0.7999999999999999 in binary arithmetic
    expect(stopGate(0.8 * 0.7, 0.7)).toMatchObject({ passed: true });
  });

  it('nor one that is 2.0 ATR except for the last bit of a decimal', () => {
    // a stop at 3996.6 for an entry at 4000 is 3.400000000000091 away: 2.0000000000000537 ATR of 1.7
    const distance = Math.abs(4000 - 3996.6);
    expect(distance / 1.7).toBeGreaterThan(2);
    expect(stopGate(distance, 1.7)).toMatchObject({ passed: true });
  });

  it('cannot be judged without an ATR', () => {
    expect(stopGate(3, null)).toEqual({ code: 'STOP_OK', passed: false, reason: 'UNKNOWN' });
    expect(stopGate(3, 0).passed).toBe(false);
    expect(stopGate(3, -1).reason).toBe('UNKNOWN');
  });

  it('takes the band from the parameters', () => {
    expect(stopGate(3, 2, { stopAtr: [1, 1.4] }).passed).toBe(false);
    expect(stopGate(3, 2, { stopAtr: [1, 1.5] }).passed).toBe(true);
    expect(() => stopGate(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe('TARGET_OK', () => {
  it('passes up to 2.5 ATR(5m) and reports the distance in ATR', () => {
    expect(targetGate(3, 2)).toEqual({ code: 'TARGET_OK', passed: true, value: 1.5, limit: 2.5 });
    expect(targetGate(5, 2).passed).toBe(true);
  });

  it('fails a little beyond 2.5 ATR', () => {
    expect(targetGate(5.02, 2)).toEqual({
      code: 'TARGET_OK',
      passed: false,
      value: 2.51,
      limit: 2.5,
    });
  });

  it('cannot be judged without an ATR', () => {
    expect(targetGate(3, null)).toEqual({
      code: 'TARGET_OK',
      passed: false,
      limit: 2.5,
      reason: 'UNKNOWN',
    });
    expect(targetGate(3, 0).passed).toBe(false);
  });

  it('takes the limit from the parameters', () => {
    expect(targetGate(4, 2, { tp1MaxAtr: 1.5 }).passed).toBe(false);
    expect(targetGate(3, 2, { tp1MaxAtr: 1.5 }).passed).toBe(true);
    expect(() => targetGate(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe('QUALITY_OK', () => {
  it('passes at a score of 65 with enough of the weight, and reports the score', () => {
    expect(qualityGate(72, 1)).toEqual({ code: 'QUALITY_OK', passed: true, value: 72, limit: 65 });
    expect(qualityGate(65, 0.7).passed).toBe(true);
  });

  it('fails below 65 and reports the score', () => {
    expect(qualityGate(64.9, 1)).toEqual({
      code: 'QUALITY_OK',
      passed: false,
      value: 64.9,
      limit: 65,
    });
  });

  it('fails when the score rests on less than 70% of the weight, even a high one', () => {
    expect(qualityGate(95, 0.69)).toEqual({
      code: 'QUALITY_OK',
      passed: false,
      value: 0.69,
      limit: 0.7,
      reason: 'COVERAGE',
    });
    expect(qualityGate(95, 0.7).passed).toBe(true);
  });

  it('fails while there is no score or no coverage', () => {
    expect(qualityGate(null, 1)).toEqual({
      code: 'QUALITY_OK',
      passed: false,
      limit: 65,
      reason: 'UNKNOWN',
    });
    expect(qualityGate(80, null).reason).toBe('UNKNOWN');
  });

  it('takes both limits from the parameters', () => {
    expect(qualityGate(70, 1, { quality: { min: 75, minCoverage: 0.7 } }).passed).toBe(false);
    expect(qualityGate(70, 0.8, { quality: { min: 65, minCoverage: 0.9 } }).reason).toBe(
      'COVERAGE',
    );
  });

  it('the ends of the scale are valid: a score of 0 or 100, a coverage of 0', () => {
    expect(qualityGate(0, 1)).toEqual({ code: 'QUALITY_OK', passed: false, value: 0, limit: 65 });
    expect(qualityGate(100, 1)).toEqual({
      code: 'QUALITY_OK',
      passed: true,
      value: 100,
      limit: 65,
    });
    expect(qualityGate(70, 0)).toMatchObject({ passed: false, reason: 'COVERAGE', value: 0 });
  });

  it('refuses a score outside 0 to 100 and a coverage outside 0 to 1', () => {
    expect(() => qualityGate(101, 1)).toThrow(RangeError);
    expect(() => qualityGate(-1, 1)).toThrow(RangeError);
    expect(() => qualityGate(Number.NaN, 1)).toThrow(RangeError);
    expect(() => qualityGate(70, 1.1)).toThrow(RangeError);
    expect(() => qualityGate(70, -0.1)).toThrow(RangeError);
  });
});

describe('all the gates together', () => {
  it('nine results in the order of GATE_CODES when a setup is given, all passing', () => {
    const evaluation = evaluateGates(MARKET_OK, SETUP_OK);
    expect(evaluation.results.map((r) => r.code)).toEqual([...GATE_CODES]);
    expect(evaluation).toMatchObject({ passed: true, complete: true, failed: [] });
    expect(evaluation.results.every((r) => r.passed)).toBe(true);
  });

  it('only the five market gates without a setup, and the evaluation is not complete', () => {
    const evaluation = evaluateGates(MARKET_OK, null);
    expect(evaluation.results.map((r) => r.code)).toEqual([
      'DATA_FRESH',
      'WARMUP_OK',
      'CLOCK_OK',
      'SPREAD_OK',
      'GAP_RECOVERY_OK',
    ]);
    expect(evaluation).toMatchObject({ passed: true, complete: false });
  });

  it('each gate can fail alone and is the only one reported', () => {
    const cases: [
      string,
      Parameters<typeof evaluateGates>[0],
      Parameters<typeof evaluateGates>[1],
    ][] = [
      ['DATA_FRESH', { ...MARKET_OK, feed: { ...MARKET_OK.feed, connected: false } }, SETUP_OK],
      ['WARMUP_OK', { ...MARKET_OK, candles: { '5m': 900, '15m': 1440, '1h': 10 } }, SETUP_OK],
      ['CLOCK_OK', { ...MARKET_OK, clockSkewMs: 6_000 }, SETUP_OK],
      ['SPREAD_OK', { ...MARKET_OK, spread: 0.9 }, SETUP_OK],
      ['GAP_RECOVERY_OK', { ...MARKET_OK, fiveMinuteOpenTimes: openTimes(5) }, SETUP_OK],
      ['REGIME_OK', MARKET_OK, { ...SETUP_OK, regime: 'RANGE' }],
      ['STOP_OK', MARKET_OK, { ...SETUP_OK, stopDistance: 9 }],
      ['TARGET_OK', MARKET_OK, { ...SETUP_OK, tp1Distance: 9 }],
      ['QUALITY_OK', MARKET_OK, { ...SETUP_OK, qualityScore: 50 }],
    ];
    for (const [code, market, setup] of cases) {
      const evaluation = evaluateGates(market, setup);
      expect(evaluation.failed, code).toEqual([code]);
      expect(evaluation.passed, code).toBe(false);
    }
  });

  it('several failures are all reported, in the order of the gates', () => {
    const evaluation = evaluateGates(
      { ...MARKET_OK, clockSkewMs: null, spread: 1 },
      { ...SETUP_OK, qualityScore: 10, regime: 'RANGE' },
    );
    expect(evaluation.failed).toEqual(['CLOCK_OK', 'SPREAD_OK', 'REGIME_OK', 'QUALITY_OK']);
  });

  it('the spread is judged against the stop of the setup when there is one', () => {
    const market = { ...MARKET_OK, spread: 0.5 };
    expect(evaluateGates(market, null).passed).toBe(true);
    const withStop = evaluateGates(market, SETUP_OK);
    expect(withStop.failed).toEqual(['SPREAD_OK']);
    expect(withStop.results[3]).toMatchObject({ value: 0.5, limit: 0.36 });
  });

  it('hands the decision candle to the gap gate', () => {
    const evaluation = evaluateGates(
      { ...MARKET_OK, fiveMinuteOpenTimes: openTimes(20, NOW - FIVE_MINUTES) },
      SETUP_OK,
    );
    expect(evaluation.failed).toEqual(['GAP_RECOVERY_OK']);
    const { decisionOpenTime: _unused, ...withoutDecision } = MARKET_OK;
    expect(
      evaluateGates(
        { ...withoutDecision, fiveMinuteOpenTimes: openTimes(20, NOW - FIVE_MINUTES) },
        SETUP_OK,
      ).passed,
    ).toBe(true);
  });

  it('uses the parameters it is given in every gate', () => {
    const strict: GateParams = {
      ...GATE_DEFAULTS,
      maxTickAgeSec: 1,
      maxClockSkewSec: 0.5,
      maxSpreadUsd: 0.1,
      gapRecoveryCandles: 30,
      stopAtr: [2, 3],
      tp1MaxAtr: 1,
      quality: { min: 90, minCoverage: 0.95 },
      warmupCandles: { '5m': 5_000, '15m': 5_000, '1h': 5_000 },
    };
    const evaluation = evaluateGates(MARKET_OK, SETUP_OK, strict);
    expect(evaluation.failed).toEqual([...GATE_CODES].filter((code) => code !== 'REGIME_OK'));
  });

  it('stores what the contract keeps: the code, whether it passed and the numbers, nothing else', () => {
    const evaluation = evaluateGates(MARKET_OK, SETUP_OK);
    const stored = storedGates(evaluation.results);
    expect(stored.map((g) => g.code)).toEqual([...GATE_CODES]);
    expect(stored[0]).toEqual({ code: 'DATA_FRESH', passed: true, value: 2, limit: 10 });
    expect(stored[5]).toEqual({ code: 'REGIME_OK', passed: true });
    const failed = storedGates([
      { code: 'WARMUP_OK', passed: false, value: 40, limit: 100, missing: ['1h'] },
      { code: 'DATA_FRESH', passed: false, reason: 'STALE' },
    ]);
    expect(failed).toEqual([
      { code: 'WARMUP_OK', passed: false, value: 40, limit: 100 },
      { code: 'DATA_FRESH', passed: false },
    ]);
  });

  it('the defaults are the numbers of docs/02 section 6', () => {
    expect(GATE_DEFAULTS).toEqual({
      maxTickAgeSec: 10,
      maxClockSkewSec: 5,
      maxSpreadUsd: 0.6,
      maxSpreadToStop: 0.12,
      gapRecoveryCandles: 12,
      stopAtr: [0.8, 2],
      tp1MaxAtr: 2.5,
      quality: { min: 65, minCoverage: 0.7 },
      warmupCandles: { '5m': 900, '15m': 1440, '1h': 600 },
    });
  });
});
