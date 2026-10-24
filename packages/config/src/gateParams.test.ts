import {
  GATE_DEFAULTS,
  STRATEGY_KEYS,
  evaluateGates,
  evaluateFlags,
  resolveModes,
  type MarketGateInputs,
  type SetupGateInputs,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { advisoryModesOf, gateParamsOf, requiredTimeframes } from './gateParams';
import { defaultStrategyConfig } from './strategy';

describe('the gates of a strategy config, as the engine reads them', () => {
  it.each(STRATEGY_KEYS)('%s: the default config gives exactly the defaults of core', (key) => {
    expect(gateParamsOf(defaultStrategyConfig(key))).toEqual(GATE_DEFAULTS);
  });

  it('follows the config: a changed limit is a changed gate', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const changed = {
      ...config,
      gates: {
        ...config.gates,
        maxSpreadUsd: 0.4,
        stopAtr: [1, 3] as [number, number],
        gapRecoveryCandles: 20,
        tp1MaxAtr: 3,
      },
      quality: { ...config.quality, min: 70, minCoverage: 0.8 },
    };
    expect(gateParamsOf(changed)).toMatchObject({
      maxSpreadUsd: 0.4,
      stopAtr: [1, 3],
      gapRecoveryCandles: 20,
      tp1MaxAtr: 3,
      quality: { min: 70, minCoverage: 0.8 },
    });
  });

  it('needs the entry, context and bias timeframes warmed up, each once', () => {
    expect(requiredTimeframes(defaultStrategyConfig('squeeze_retest'))).toEqual([
      '5m',
      '15m',
      '1h',
    ]);
    const config = defaultStrategyConfig('trend_pullback');
    expect(
      requiredTimeframes({ ...config, timeframes: { entry: '5m', context: '5m', bias: '1h' } }),
    ).toEqual(['5m', '1h']);
  });

  it('every required timeframe has a warm-up size', () => {
    for (const key of STRATEGY_KEYS) {
      const config = defaultStrategyConfig(key);
      for (const tf of requiredTimeframes(config)) {
        expect(GATE_DEFAULTS.warmupCandles[tf], `${key} ${tf}`).toBeGreaterThan(0);
      }
    }
  });

  it('the advisory defaults of the config are the starting modes: all warn', () => {
    for (const key of STRATEGY_KEYS) {
      expect(advisoryModesOf(defaultStrategyConfig(key))).toEqual({
        newsWindow: 'warn',
        rollover: 'warn',
        offHours: 'warn',
        nearLevel: 'warn',
      });
    }
    const config = defaultStrategyConfig('trend_pullback');
    const modes = advisoryModesOf({
      ...config,
      advisory: { ...config.advisory, rollover: 'block' },
    });
    expect(resolveModes(modes, { offHours: 'block' })).toEqual({
      newsWindow: 'warn',
      rollover: 'block',
      offHours: 'block',
      nearLevel: 'warn',
    });
  });

  it('runs the gates of a strategy end to end', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const params = gateParamsOf(config);
    const last = Date.UTC(2026, 0, 14, 14, 0);
    const market: MarketGateInputs = {
      feed: { connected: true, tickAgeMs: 1_000, providerStale: false, marketState: 'OPEN' },
      candles: { '5m': 5_000, '15m': 2_000, '1h': 700 },
      requiredTimeframes: requiredTimeframes(config),
      clockSkewMs: 900,
      spread: 0.2,
      fiveMinuteOpenTimes: Array.from({ length: 20 }, (_, i) => last - (19 - i) * 300_000),
      decisionOpenTime: last,
    };
    const setup: SetupGateInputs = {
      regime: 'TREND_UP',
      acceptedRegimes: config.acceptedRegimes,
      atr5: 2,
      stopDistance: 3,
      tp1Distance: 3,
      qualityScore: 72,
      qualityCoverage: 1,
    };
    const gates = evaluateGates(market, setup, params);
    expect(gates).toMatchObject({ passed: true, complete: true, failed: [] });
    expect(evaluateGates(market, { ...setup, regime: 'RANGE' }, params).failed).toEqual([
      'REGIME_OK',
    ]);
    expect(
      evaluateFlags({ now: last, calendar: null, newsShock: null, lastHighHeadlineAt: null }, null),
    ).toHaveLength(9);
  });
});
