import {
  QUALITY_GROUPS,
  RISK_DEFAULTS,
  STRATEGY_KEYS,
  planTrade,
  scoreQuality,
  type QualityStrengths,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { qualityWeightsOf, riskParamsOf } from './riskParams';
import { defaultStrategyConfig } from './strategy';

describe('the trade model of a strategy config, as the engine reads it', () => {
  it.each(STRATEGY_KEYS)(
    '%s: the default config gives the defaults of core, with its own exit profile',
    (key) => {
      const params = riskParamsOf(defaultStrategyConfig(key));
      expect(params.exitProfile).toBe(key === 'pattern_breakout' ? 'EP3_STRUCTURE' : 'EP1_PARTIAL');
      expect({ ...params, exitProfile: RISK_DEFAULTS.exitProfile }).toEqual(RISK_DEFAULTS);
    },
  );

  it('has the eight numbers of the model, and no more', () => {
    expect(Object.keys(riskParamsOf(defaultStrategyConfig('trend_pullback'))).sort()).toEqual(
      Object.keys(RISK_DEFAULTS).sort(),
    );
  });

  it('follows the config: a changed number is a changed number', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const changed = {
      ...config,
      risk: {
        exitProfile: 'EP2_SINGLE' as const,
        simSlippageUsd: 0.3,
        execDelaySec: 20,
        commissionUsdPerOz: 0.5,
        entryValidSec: 90,
        maxChaseAtr: 0.2,
        maxChaseRiskFraction: 0.3,
        timeStopMin: 60,
      },
    };
    expect(riskParamsOf(changed)).toEqual(changed.risk);
  });

  it('plans a trade from a default config', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const decidedAt = Date.UTC(2026, 9, 23, 6, 5, 0);
    const result = planTrade(
      {
        side: 'BUY',
        decidedAt,
        quote: { t: decidedAt, bid: 4017.2, ask: 4017.32 },
        stopLoss: 4010.9,
        atr5: 4.3,
        structureTarget: null,
        minMeasuredMoveR: null,
      },
      riskParamsOf(config),
    );
    expect(result).toMatchObject({
      ok: true,
      plan: { entry: 4017.37, tp1: 4023.84, tp2: 4030.31, riskDistance: 6.47 },
    });
  });
});

describe('the quality weights of a strategy config', () => {
  it('are the weights of the config, one for each group', () => {
    const config = defaultStrategyConfig('trend_pullback');
    const weights = qualityWeightsOf(config);
    expect(Object.keys(weights)).toEqual([...QUALITY_GROUPS]);
    expect(weights).toEqual(config.quality.weights);
    expect(weights).toEqual({
      trend: 0.22,
      structure: 0.22,
      trigger: 0.14,
      volatility: 0.1,
      execution: 0.12,
      sessionMacro: 0.12,
      reward: 0.08,
    });
  });

  it('is a copy, so a score cannot change the config', () => {
    const config = defaultStrategyConfig('trend_pullback');
    expect(qualityWeightsOf(config)).not.toBe(config.quality.weights);
  });

  it('score a setup from a default config', () => {
    const strengths = Object.fromEntries(
      QUALITY_GROUPS.map((group) => [group, 0.8]),
    ) as QualityStrengths;
    for (const key of STRATEGY_KEYS) {
      const result = scoreQuality(strengths, qualityWeightsOf(defaultStrategyConfig(key)));
      expect(result.score).toBe(80);
      expect(result.coverage).toBeCloseTo(1, 12);
    }
  });
});
