import { STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  STRATEGY_CONFIG_VERSION,
  defaultStrategyConfig,
  gatesConfigSchema,
  qualityConfigSchema,
  riskConfigSchema,
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
    expect(defaultStrategyConfig('trend_pullback').gates.maxSpreadUsd).toBe(0.6);
  });

  it('carries the documented gate and risk numbers', () => {
    const { gates, risk } = defaultStrategyConfig('trend_pullback');
    expect(gates).toEqual({
      dataFreshSec: 10,
      clockSkewSec: 5,
      maxSpreadUsd: 0.6,
      maxSpreadStopFraction: 0.12,
      gapRecoveryCandles: 12,
      stopAtrMin: 0.8,
      stopAtrMax: 2.0,
      tp1AtrMax: 2.5,
      minQuality: 65,
    });
    expect(risk).toMatchObject({
      exitProfile: 'EP1_PARTIAL',
      simSlippageUsd: 0.05,
      commissionUsdPerOz: 0,
      entryValidSec: 180,
      timeStopMin: 120,
    });
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
});

describe('gates, risk and quality', () => {
  const gates = defaultStrategyConfig('trend_pullback').gates;
  const risk = defaultStrategyConfig('trend_pullback').risk;
  const quality = defaultStrategyConfig('trend_pullback').quality;

  it('requires the stop band to be ordered', () => {
    expect(ok(gatesConfigSchema, { ...gates, stopAtrMin: 2.0, stopAtrMax: 0.8 })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, stopAtrMin: 1, stopAtrMax: 1 })).toBe(false);
  });

  it('does not allow a quality threshold below the lowest grade', () => {
    expect(ok(gatesConfigSchema, { ...gates, minQuality: 64 })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, minQuality: 70 })).toBe(true);
    expect(ok(gatesConfigSchema, { ...gates, minQuality: 101 })).toBe(false);
  });

  it('rejects a zero or negative spread limit', () => {
    expect(ok(gatesConfigSchema, { ...gates, maxSpreadUsd: 0 })).toBe(false);
    expect(ok(gatesConfigSchema, { ...gates, maxSpreadStopFraction: 1.5 })).toBe(false);
  });

  it('rejects an unknown exit profile and negative costs', () => {
    expect(ok(riskConfigSchema, { ...risk, exitProfile: 'EP9_MAGIC' })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, simSlippageUsd: -0.01 })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, commissionUsdPerOz: -1 })).toBe(false);
    expect(ok(riskConfigSchema, { ...risk, timeStopMin: 0 })).toBe(false);
  });

  it('requires quality weights that add up to 1 and cover every group', () => {
    expect(
      ok(qualityConfigSchema, { ...quality, weights: { ...quality.weights, trend: 0.3 } }),
    ).toBe(false);
    const { reward: _reward, ...missing } = quality.weights;
    expect(ok(qualityConfigSchema, { ...quality, weights: missing })).toBe(false);
    expect(ok(qualityConfigSchema, { ...quality, weights: { ...quality.weights, vibes: 0 } })).toBe(
      false,
    );
  });

  it('accepts re-weighted groups that still add up to 1', () => {
    const weights = { ...quality.weights, trend: 0.27, reward: 0.03 };
    expect(ok(qualityConfigSchema, { ...quality, weights })).toBe(true);
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
