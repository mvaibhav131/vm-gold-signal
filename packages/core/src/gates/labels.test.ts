import { describe, expect, it } from 'vitest';

import { evaluateGates } from './blocking';
import { gateLabel, gateWaitReasons } from './labels';
import { MARKET_OK, SETUP_OK } from './test-data';
import type { GateResult } from './types';

const failed = (result: Omit<GateResult, 'passed'>): GateResult => ({ ...result, passed: false });

describe('the words of a failed gate', () => {
  it('DATA_FRESH, by reason', () => {
    const label = (reason: GateResult['reason'], value?: number) =>
      gateLabel(
        failed({
          code: 'DATA_FRESH',
          ...(reason ? { reason } : {}),
          ...(value === undefined ? {} : { value }),
        }),
      );
    expect(label('STALE', 18.4)).toBe('No tick for 18 s: new signals are blocked');
    expect(label('STALE', 10.6)).toBe('No tick for 11 s: new signals are blocked');
    expect(label('DISCONNECTED')).toBe('Feed disconnected: new signals are blocked');
    expect(label('NO_TICK')).toBe('No tick received yet: new signals are blocked');
    expect(label('PROVIDER_STALE')).toBe(
      'The data provider marks its quote as stale: new signals are blocked',
    );
    expect(label('MARKET_CLOSED')).toBe('Market closed: new signals wait for the reopening');
    expect(label('MARKET_UNKNOWN')).toBe('Market state unknown: new signals are blocked');
    expect(label(undefined)).toBe('Data is not fresh: new signals are blocked');
  });

  it('WARMUP_OK names the timeframes that are missing', () => {
    expect(gateLabel(failed({ code: 'WARMUP_OK', missing: ['1h', '4h'] }))).toBe(
      'Warming up: 1h and 4h candles are still missing',
    );
    expect(gateLabel(failed({ code: 'WARMUP_OK', missing: ['1h'] }))).toBe(
      'Warming up: 1h candles are still missing',
    );
    expect(gateLabel(failed({ code: 'WARMUP_OK', missing: ['5m', '15m', '1h'] }))).toBe(
      'Warming up: 5m, 15m and 1h candles are still missing',
    );
  });

  it('CLOCK_OK, with the skew or without it', () => {
    expect(gateLabel(failed({ code: 'CLOCK_OK', value: 6.25, limit: 5 }))).toBe(
      'Clock differs from the feed by 6.3 s: new signals are blocked',
    );
    expect(gateLabel(failed({ code: 'CLOCK_OK', reason: 'UNKNOWN' }))).toBe(
      'Clock difference not known yet: new signals are blocked',
    );
  });

  it('SPREAD_OK, in the words of the dashboard', () => {
    expect(gateLabel(failed({ code: 'SPREAD_OK', value: 0.9, limit: 0.6 }))).toBe(
      'Spread too high: 0.90 USD',
    );
    expect(gateLabel(failed({ code: 'SPREAD_OK', limit: 0.6, reason: 'UNKNOWN' }))).toBe(
      'Spread not known: new signals are blocked',
    );
  });

  it('GAP_RECOVERY_OK says how far the recovery is', () => {
    expect(gateLabel(failed({ code: 'GAP_RECOVERY_OK', value: 4, limit: 12 }))).toBe(
      'Recovering from a data gap: 4 of 12 clean 5m candles',
    );
    expect(
      gateLabel(failed({ code: 'GAP_RECOVERY_OK', value: 0, limit: 12, reason: 'MISSING_CANDLE' })),
    ).toBe('The latest 5m candle is missing: new signals are blocked');
    expect(
      gateLabel(failed({ code: 'GAP_RECOVERY_OK', value: 0, limit: 12, reason: 'UNKNOWN' })),
    ).toBe('No 5m candles yet: new signals are blocked');
  });

  it('REGIME_OK names the regime in plain words', () => {
    const result = failed({ code: 'REGIME_OK' });
    expect(gateLabel(result, { regime: 'RANGE' })).toBe('Regime: range, no strategy accepts it');
    expect(gateLabel(result, { regime: 'TREND_UP' })).toBe(
      'Regime: trend up, no strategy accepts it',
    );
    expect(gateLabel(result, { regime: 'HIGH_VOL' })).toBe(
      'Regime: high vol, no strategy accepts it',
    );
    expect(gateLabel(result)).toBe('Regime: no strategy accepts it');
  });

  it('STOP_OK says which side of the band it is on', () => {
    expect(gateLabel(failed({ code: 'STOP_OK', value: 0.6, limit: 0.8 }))).toBe(
      'Stop too tight: 0.6 ATR (at least 0.8)',
    );
    expect(gateLabel(failed({ code: 'STOP_OK', value: 2.44, limit: 2 }))).toBe(
      'Stop too wide: 2.4 ATR (at most 2)',
    );
    expect(gateLabel(failed({ code: 'STOP_OK', reason: 'UNKNOWN' }))).toBe(
      'ATR not known: the stop cannot be checked',
    );
  });

  it('TARGET_OK', () => {
    expect(gateLabel(failed({ code: 'TARGET_OK', value: 3.04, limit: 2.5 }))).toBe(
      'First target too far: 3.0 ATR (at most 2.5)',
    );
    expect(gateLabel(failed({ code: 'TARGET_OK', limit: 2.5, reason: 'UNKNOWN' }))).toBe(
      'ATR not known: the target cannot be checked',
    );
  });

  it('QUALITY_OK: a low score, too little data, or no score', () => {
    expect(gateLabel(failed({ code: 'QUALITY_OK', value: 64.6, limit: 65 }))).toBe(
      'Quality score 64.6 is below 65',
    );
    expect(
      gateLabel(failed({ code: 'QUALITY_OK', value: 0.55, limit: 0.7, reason: 'COVERAGE' })),
    ).toBe('Too little data for a quality score: 55% of the weight (at least 70%)');
    // rounded, not cut off: 55.5% is 56%
    expect(
      gateLabel(failed({ code: 'QUALITY_OK', value: 0.555, limit: 0.7, reason: 'COVERAGE' })),
    ).toContain('56% of the weight');
    expect(gateLabel(failed({ code: 'QUALITY_OK', limit: 65, reason: 'UNKNOWN' }))).toBe(
      'No quality score yet',
    );
  });

  it('a gate that passed has nothing to wait for', () => {
    expect(() => gateLabel({ code: 'SPREAD_OK', passed: true, value: 0.2, limit: 0.6 })).toThrow(
      'passed',
    );
  });
});

describe('the wait reasons of a set of gates', () => {
  it('one reason per failed gate, in the order of the gates, none when all pass', () => {
    expect(gateWaitReasons(evaluateGates(MARKET_OK, SETUP_OK).results)).toEqual([]);
    const evaluation = evaluateGates(
      { ...MARKET_OK, spread: 0.9, feed: { ...MARKET_OK.feed, tickAgeMs: 18_400 } },
      { ...SETUP_OK, regime: 'RANGE', stopDistance: 9 },
    );
    expect(gateWaitReasons(evaluation.results, { regime: 'RANGE' })).toEqual([
      { code: 'DATA_FRESH', label: 'No tick for 18 s: new signals are blocked' },
      { code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' },
      { code: 'REGIME_OK', label: 'Regime: range, no strategy accepts it' },
      { code: 'STOP_OK', label: 'Stop too wide: 4.5 ATR (at most 2)' },
    ]);
  });

  it('every label is a non-empty line for every gate that can fail', () => {
    const evaluation = evaluateGates(
      {
        feed: { connected: false, tickAgeMs: null, providerStale: null, marketState: 'UNKNOWN' },
        candles: {},
        requiredTimeframes: ['5m', '1h'],
        clockSkewMs: null,
        spread: null,
        fiveMinuteOpenTimes: [],
      },
      { ...SETUP_OK, regime: 'RANGE', atr5: null, qualityScore: null, qualityCoverage: null },
    );
    const reasons = gateWaitReasons(evaluation.results);
    expect(reasons).toHaveLength(9);
    for (const reason of reasons) expect(reason.label.length).toBeGreaterThan(10);
  });
});
