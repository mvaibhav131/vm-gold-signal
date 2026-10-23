import { STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  STRATEGY_CONFIG_VERSION,
  advisoryConfigSchema,
  defaultStrategyConfig,
  gatesConfigSchema,
  policyConfigSchema,
  qualityConfigSchema,
  riskConfigSchema,
  statsConfigSchema,
  strategyConfigHash,
  strategyConfigSchema,
} from './strategy';

function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe('default strategy configs (v0.1.0)', () => {
  it.each(STRATEGY_KEYS)('%s parses and keeps its key', (key) => {
    const config = defaultStrategyConfig(key);
    expect(config.strategyKey).toBe(key);
    expect(config.version).toBe(STRATEGY_CONFIG_VERSION);
    expect(strategyConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it('returns a fresh copy every time', () => {
    const a = defaultStrategyConfig('trend_pullback');
    a.gates.maxSpreadUsd = 99;
    a.gates.newsWindow.currency.push('EUR');
    const b = defaultStrategyConfig('trend_pullback');
    expect(b.gates.maxSpreadUsd).toBe(0.6);
    expect(b.gates.newsWindow.currency).toEqual(['USD']);
  });

  it('matches the config excerpt of 02_Signal_Engine section 17, key for key', () => {
    expect(defaultStrategyConfig('trend_pullback')).toMatchObject({
      timeframes: { entry: '5m', context: '15m', bias: '1h' },
      gates: {
        maxTickAgeSec: 10,
        maxSpreadUsd: 0.6,
        maxSpreadToStop: 0.12,
        stopAtr: [0.8, 2.0],
        tp1MaxAtr: 2.5,
        newsWindow: { before: 45, after: 20, impact: ['high'], currency: ['USD'] },
      },
      quality: { min: 65, minCoverage: 0.7 },
      policy: { throttles: 'none', dedupe: 'per_setup_instance' },
      advisory: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
      risk: {
        simSlippageUsd: 0.05,
        entryValidSec: 180,
        maxChaseAtr: 0.15,
        exitProfile: 'EP1_PARTIAL',
        timeStopMin: 120,
      },
      stats: { minN: 30, lowSampleBelow: 100 },
    });
  });

  it('carries the other documented numbers (clock skew, gap recovery, commission, entry chase cap)', () => {
    const { gates, risk } = defaultStrategyConfig('trend_pullback');
    expect(gates.maxClockSkewSec).toBe(5);
    expect(gates.gapRecoveryCandles).toBe(12);
    expect(risk.commissionUsdPerOz).toBe(0);
    expect(risk.maxChaseRiskFraction).toBe(0.25);
  });

  it('uses the documented quality weights', () => {
    expect(defaultStrategyConfig('trend_pullback').quality.weights).toEqual({
      trend: 0.22,
      structure: 0.22,
      trigger: 0.14,
      volatility: 0.1,
      execution: 0.12,
      sessionMacro: 0.12,
      reward: 0.08,
    });
  });

  it('accepts the documented regimes per strategy', () => {
    expect(defaultStrategyConfig('trend_pullback').acceptedRegimes).toEqual([
      'TREND_UP',
      'TREND_DOWN',
    ]);
    expect(defaultStrategyConfig('squeeze_retest').acceptedRegimes).toEqual([
      'SQUEEZE',
      'BREAKOUT',
    ]);
    expect(defaultStrategyConfig('pattern_breakout').acceptedRegimes).not.toContain('HIGH_VOL');
  });

  it('uses the structure exit profile for the pattern strategy only', () => {
    expect(defaultStrategyConfig('pattern_breakout').risk.exitProfile).toBe('EP3_STRUCTURE');
    expect(defaultStrategyConfig('trendline_retest').risk.exitProfile).toBe('EP1_PARTIAL');
  });

  it('carries the strategy rules of section 7', () => {
    expect(defaultStrategyConfig('trend_pullback').params).toMatchObject({
      rsiPullbackMax: 45,
      rsiLookbackCandles: 12,
      macdRisingCandles: 2,
      stopBufferAtr: 0.25,
    });
    expect(defaultStrategyConfig('trendline_retest').params).toMatchObject({
      minTouches: 3,
      maxAdx1hAgainst: 30,
      retestMinRsi: 45,
    });
    expect(defaultStrategyConfig('pattern_breakout').params).toMatchObject({
      minMeasuredMoveR: 1.5,
    });
  });
});

describe('strategyConfigSchema rejections', () => {
  const base = () => defaultStrategyConfig('trend_pullback');

  it('rejects unknown fields at every level', () => {
    expect(ok(strategyConfigSchema, { ...base(), extra: 1 })).toBe(false);
    const withParam = base();
    expect(
      ok(strategyConfigSchema, { ...withParam, params: { ...withParam.params, magic: 1 } }),
    ).toBe(false);
  });

  it('rejects params that belong to another strategy', () => {
    const c = defaultStrategyConfig('sweep_reversal');
    expect(ok(strategyConfigSchema, { ...c, strategyKey: 'trend_pullback' })).toBe(false);
  });

  it('rejects an unknown strategy and a bad version', () => {
    expect(ok(strategyConfigSchema, { ...base(), strategyKey: 'martingale' })).toBe(false);
    expect(ok(strategyConfigSchema, { ...base(), version: 'v1' })).toBe(false);
  });

  it('rejects empty or duplicate regime lists', () => {
    expect(ok(strategyConfigSchema, { ...base(), acceptedRegimes: [] })).toBe(false);
    expect(ok(strategyConfigSchema, { ...base(), acceptedRegimes: ['RANGE', 'RANGE'] })).toBe(
      false,
    );
    expect(ok(strategyConfigSchema, { ...base(), acceptedRegimes: ['SIDEWAYS'] })).toBe(false);
  });

  it('rejects non-numeric and non-finite parameters', () => {
    const c = base();
    expect(ok(strategyConfigSchema, { ...c, params: { ...c.params, stopBufferAtr: '0.25' } })).toBe(
      false,
    );
    expect(
      ok(strategyConfigSchema, { ...c, params: { ...c.params, stopBufferAtr: Number.NaN } }),
    ).toBe(false);
    expect(ok(strategyConfigSchema, { ...c, params: { ...c.params, stopBufferAtr: -1 } })).toBe(
      false,
    );
  });

  it('requires timeframes to grow from entry to context to bias', () => {
    const c = base();
    expect(
      ok(strategyConfigSchema, { ...c, timeframes: { entry: '15m', context: '5m', bias: '1h' } }),
    ).toBe(false);
    expect(
      ok(strategyConfigSchema, { ...c, timeframes: { entry: '5m', context: '5m', bias: '1h' } }),
    ).toBe(false);
    expect(
      ok(strategyConfigSchema, { ...c, timeframes: { entry: '5m', context: '1h', bias: '4h' } }),
    ).toBe(true);
  });
});

describe('gates', () => {
  const gates = defaultStrategyConfig('trend_pullback').gates;

  it('requires the stop band to be [min, max] in order', () => {
    expect(ok(gatesConfigSchema, { ...gates, stopAtr: [2.0, 0.8] })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, stopAtr: [1, 1] })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, stopAtr: [0.8] })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, stopAtr: [0.5, 3] })).toBe(true);
  });

  it('rejects a zero or negative spread limit and a spread share above 1', () => {
    expect(ok(gatesConfigSchema, { ...gates, maxSpreadUsd: 0 })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, maxSpreadToStop: 1.5 })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, maxTickAgeSec: -1 })).toBe(false);
  });

  it('validates the news window', () => {
    const w = gates.newsWindow;
    expect(ok(gatesConfigSchema, { ...gates, newsWindow: { ...w, before: -5 } })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, newsWindow: { ...w, impact: [] } })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, newsWindow: { ...w, impact: ['critical'] } })).toBe(
      false,
    );
    expect(ok(gatesConfigSchema, { ...gates, newsWindow: { ...w, currency: ['usd'] } })).toBe(
      false,
    );
    expect(
      ok(gatesConfigSchema, { ...gates, newsWindow: { ...w, currency: ['USD', 'EUR'] } }),
    ).toBe(true);
  });
});

describe('quality, policy, advisory, risk and stats', () => {
  const config = defaultStrategyConfig('trend_pullback');
  const quality = config.quality;
  const risk = config.risk;

  it('does not allow a quality threshold below the lowest grade', () => {
    expect(ok(qualityConfigSchema, { ...quality, min: 64 })).toBe(false);
    expect(ok(qualityConfigSchema, { ...quality, min: 70 })).toBe(true);
    expect(ok(qualityConfigSchema, { ...quality, min: 101 })).toBe(false);
    expect(ok(qualityConfigSchema, { ...quality, minCoverage: 0 })).toBe(false);
  });

  it('requires quality weights that add up to 1 and cover every group', () => {
    expect(
      ok(qualityConfigSchema, { ...quality, weights: { ...quality.weights, trend: 0.3 } }),
    ).toBe(false);
    const { reward: _reward, ...missing } = quality.weights;
    expect(ok(qualityConfigSchema, { ...quality, weights: missing })).toBe(false);
    expect(
      ok(qualityConfigSchema, { ...quality, weights: { ...quality.weights, vibes: 0.01 } }),
    ).toBe(false);
  });

  it('accepts re-weighted groups that still add up to 1', () => {
    const weights = { ...quality.weights, trend: 0.27, reward: 0.03 };
    expect(ok(qualityConfigSchema, { ...quality, weights })).toBe(true);
  });

  it('writes rule C10 into the config: no throttles, one signal per setup', () => {
    expect(ok(policyConfigSchema, { throttles: 'none', dedupe: 'per_setup_instance' })).toBe(true);
    expect(ok(policyConfigSchema, { throttles: 'daily_cap', dedupe: 'per_setup_instance' })).toBe(
      false,
    );
    expect(ok(policyConfigSchema, { throttles: 'none', dedupe: 'cooldown' })).toBe(false);
    expect(ok(policyConfigSchema, { throttles: 'none' })).toBe(false);
  });

  it('allows warn or block per advisory flag and nothing else', () => {
    const advisory = config.advisory;
    expect(ok(advisoryConfigSchema, { ...advisory, nearLevel: 'block' })).toBe(true);
    expect(ok(advisoryConfigSchema, { ...advisory, nearLevel: 'ignore' })).toBe(false);
    expect(ok(advisoryConfigSchema, { ...advisory, headlineRecent: 'warn' })).toBe(false);
  });

  it('rejects an unknown exit profile, negative costs and a zero time stop', () => {
    expect(ok(riskConfigSchema, { ...risk, exitProfile: 'EP9_MAGIC' })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, simSlippageUsd: -0.01 })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, commissionUsdPerOz: -1 })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, timeStopMin: 0 })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, entryValidSec: 0 })).toBe(false);
  });

  it('keeps the evidence thresholds fixed at 30 and 100 (rule C6)', () => {
    expect(ok(statsConfigSchema, { minN: 30, lowSampleBelow: 100 })).toBe(true);
    expect(ok(statsConfigSchema, { minN: 10, lowSampleBelow: 100 })).toBe(false);
    expect(ok(statsConfigSchema, { minN: 30, lowSampleBelow: 50 })).toBe(false);
  });
});

describe('strategyConfigHash', () => {
  it('is a stable 64 character hex digest', () => {
    const hash = strategyConfigHash(defaultStrategyConfig('trend_pullback'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(strategyConfigHash(defaultStrategyConfig('trend_pullback'))).toBe(hash);
  });

  it('does not depend on the order keys are written in', () => {
    const c = defaultStrategyConfig('trend_pullback');
    const reordered = Object.fromEntries(Object.entries(c).reverse());
    expect(strategyConfigHash(reordered)).toBe(strategyConfigHash(c));
  });

  it('changes when a single parameter changes (a new version is required)', () => {
    const a = defaultStrategyConfig('trend_pullback');
    const b = defaultStrategyConfig('trend_pullback');
    b.gates.maxSpreadUsd = 0.61;
    expect(strategyConfigHash(b)).not.toBe(strategyConfigHash(a));
  });

  it('differs between strategies', () => {
    const hashes = new Set(
      STRATEGY_KEYS.map((key) => strategyConfigHash(defaultStrategyConfig(key))),
    );
    expect(hashes.size).toBe(STRATEGY_KEYS.length);
  });

  it('refuses to hash a config that does not validate', () => {
    expect(() => strategyConfigHash({ strategyKey: 'trend_pullback' })).toThrow();
  });
});
