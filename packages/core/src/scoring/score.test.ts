import { describe, expect, it } from 'vitest';

import { QUALITY_GROUPS, type GroupState } from '../domain';
import type { QualityInputs } from './groups';
import {
  qualityStrengths,
  scoreQuality,
  type QualityStrengths,
  type QualityWeights,
} from './score';

const WEIGHTS: QualityWeights = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.08,
  execution: 0.1,
  sessionMacro: 0.1,
  reward: 0.14,
};

const all = (
  strength: number | null,
  change: Partial<QualityStrengths> = {},
): QualityStrengths => ({
  trend: strength,
  structure: strength,
  trigger: strength,
  volatility: strength,
  execution: strength,
  sessionMacro: strength,
  reward: strength,
  ...change,
});

describe('scoreQuality: the weighted mean of the groups, 0 to 100', () => {
  it('is 100 when every group is full', () => {
    const result = scoreQuality(all(1), WEIGHTS);
    expect(result.score).toBe(100);
    expect(result.coverage).toBe(1);
    expect(result.grade).toBe('Very strong');
    expect(result.groups.map((group) => group.key)).toEqual([...QUALITY_GROUPS]);
    expect(result.groups.every((group) => group.state === 'STRONG' && group.strength === 1)).toBe(
      true,
    );
  });

  it('weighs the groups', () => {
    // trend full (0.22) and structure half (0.11): 33 of 100
    const result = scoreQuality(all(0, { trend: 1, structure: 0.5 }), WEIGHTS);
    expect(result.score).toBe(33);
    expect(result.grade).toBeNull();
    expect(scoreQuality(all(1, { reward: 0 }), WEIGHTS).score).toBe(86);
    expect(scoreQuality(all(1, { volatility: 0 }), WEIGHTS).score).toBe(92);
  });

  it('does not need weights that add up to 1', () => {
    const doubled = Object.fromEntries(
      QUALITY_GROUPS.map((key) => [key, WEIGHTS[key] * 2]),
    ) as QualityWeights;
    expect(scoreQuality(all(0, { trend: 1 }), doubled).score).toBe(22);
    expect(scoreQuality(all(0.8), doubled).score).toBe(80);
  });

  it('gives the grades at 65, 75 and 90, not below', () => {
    const grade = (strength: number) => scoreQuality(all(strength), WEIGHTS).grade;
    expect(grade(0.6499)).toBeNull();
    expect(grade(0.65)).toBe('Moderate');
    expect(grade(0.7499)).toBe('Moderate');
    expect(grade(0.75)).toBe('Strong');
    expect(grade(0.8999)).toBe('Strong');
    expect(grade(0.9)).toBe('Very strong');
    expect(grade(0)).toBeNull();
  });

  it('rounds the score to 2 decimals, and does not let a float error cross a grade', () => {
    expect(scoreQuality(all(0.65), WEIGHTS).score).toBe(65);
    expect(scoreQuality(all(0.75), WEIGHTS).score).toBe(75);
    expect(scoreQuality(all(0.9), WEIGHTS).score).toBe(90);
    expect(scoreQuality(all(0.6499), WEIGHTS).score).toBe(64.99);
    expect(scoreQuality(all(0.33333), WEIGHTS).score).toBe(33.33);
    expect(scoreQuality(all(0.66667), WEIGHTS).score).toBe(66.67);
  });
});

describe('scoreQuality: groups without data', () => {
  it('give their weight to the others, so the score rests on what exists', () => {
    const result = scoreQuality(all(1, { reward: null, sessionMacro: null }), WEIGHTS);
    expect(result.score).toBe(100);
    expect(result.coverage).toBeCloseTo(0.76, 12);
    expect(scoreQuality(all(0.5, { reward: null, sessionMacro: null }), WEIGHTS).score).toBe(50);
    // trend 1 and structure 0 with only those two: 0.22 of 0.44
    expect(scoreQuality(all(null, { trend: 1, structure: 0 }), WEIGHTS).score).toBe(50);
    expect(scoreQuality(all(null, { trend: 1, trigger: 0 }), WEIGHTS).score).toBe(61.11);
  });

  it('are NA and have no strength', () => {
    const result = scoreQuality(all(1, { volatility: null }), WEIGHTS);
    const volatility = result.groups.find((group) => group.key === 'volatility');
    expect(volatility).toEqual({ key: 'volatility', state: 'NA', strength: null });
    expect(result.coverage).toBeCloseTo(0.92, 12);
  });

  it('give no score at all when no group has data', () => {
    const result = scoreQuality(all(null), WEIGHTS);
    expect(result.score).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.coverage).toBe(0);
    expect(result.groups.every((group) => group.state === 'NA' && group.strength === null)).toBe(
      true,
    );
  });

  it('give no score when the only data is in a group without weight', () => {
    const weights = { ...WEIGHTS, trend: 0 };
    const result = scoreQuality(all(null, { trend: 1 }), weights);
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0);
  });

  it('a group with no weight takes no part, but is still reported', () => {
    const weights = { ...WEIGHTS, trend: 0 };
    const result = scoreQuality(all(1, { trend: 0 }), weights);
    expect(result.score).toBe(100);
    expect(result.groups[0]).toEqual({ key: 'trend', state: 'FAIL', strength: 0 });
  });
});

describe('scoreQuality: the state of each group', () => {
  it('is STRONG from 0.75, OK from 0.5, WEAK from 0.25 and FAIL below', () => {
    const strengths: QualityStrengths = {
      trend: 0.75,
      structure: 0.5,
      trigger: 0.25,
      volatility: 0.2499,
      execution: 1,
      sessionMacro: 0,
      reward: null,
    };
    const states = scoreQuality(strengths, WEIGHTS).groups.map((group) => group.state);
    expect(states).toEqual<GroupState[]>(['STRONG', 'OK', 'WEAK', 'FAIL', 'STRONG', 'FAIL', 'NA']);
  });

  it('is decided by the strength that is stored, at 4 decimals', () => {
    const result = scoreQuality(all(0.74996), WEIGHTS);
    expect(result.groups[0]).toEqual({ key: 'trend', state: 'STRONG', strength: 0.75 });
    const below = scoreQuality(all(0.74994), WEIGHTS);
    expect(below.groups[0]).toEqual({ key: 'trend', state: 'OK', strength: 0.7499 });
    expect(scoreQuality(all(0.123456), WEIGHTS).groups[1]?.strength).toBe(0.1235);
  });
});

describe('scoreQuality refuses what makes no sense', () => {
  it('a strength outside 0 to 1', () => {
    for (const bad of [1.0001, -0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreQuality(all(1, { reward: bad }), WEIGHTS)).toThrow(RangeError);
    }
    expect(() => scoreQuality(all(1, { trend: 0 }), WEIGHTS)).not.toThrow();
  });

  it('a weight that is negative or not finite', () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreQuality(all(1), { ...WEIGHTS, execution: bad })).toThrow(RangeError);
    }
  });

  it('weights that add up to nothing', () => {
    const zero = Object.fromEntries(QUALITY_GROUPS.map((key) => [key, 0])) as QualityWeights;
    expect(() => scoreQuality(all(1), zero)).toThrow(RangeError);
  });
});

describe('qualityStrengths: each group is fed with its own facts', () => {
  const noFacts: QualityInputs = {
    trend: {
      ema20: null,
      ema50: null,
      ema200: null,
      ema50SlopeAtr: null,
      adx: null,
      plusDI: null,
      minusDI: null,
      supertrend: null,
    },
    structure: {
      state15m: null,
      state5m: null,
      breakEvent: null,
      sweep: null,
      confluence: null,
      patternMoveR: null,
    },
    trigger: {
      rangeAtr: null,
      closeLocation: null,
      rsiNow: null,
      rsiExtreme: null,
      macdBars: null,
    },
    volatility: { atrPercentile: null, squeeze: null },
    execution: { spreadPercentile: null, stopAtr: null },
    sessionMacro: { session: null, news: null },
    reward: { tp1Atr: null, levelRoom: null },
  };

  it('is null for every group without a fact', () => {
    expect(qualityStrengths('BUY', noFacts)).toEqual(all(null));
    expect(qualityStrengths('SELL', noFacts)).toEqual(all(null));
  });

  it('gives each group its number, so that a swap would show', () => {
    const inputs = (side: 'BUY' | 'SELL'): QualityInputs => ({
      trend: { ...noFacts.trend, supertrend: side === 'BUY' ? 'UP' : 'DOWN' },
      structure: { ...noFacts.structure, breakEvent: 'NONE' },
      trigger: { ...noFacts.trigger, macdBars: side === 'BUY' ? 2.25 : -2.25 },
      volatility: { atrPercentile: null, squeeze: 'ON' },
      execution: { spreadPercentile: 95, stopAtr: null },
      sessionMacro: { session: 'NEW_YORK', news: null },
      reward: { tp1Atr: 2.1, levelRoom: null },
    });
    for (const side of ['BUY', 'SELL'] as const) {
      const strengths = qualityStrengths(side, inputs(side));
      expect(strengths.trend).toBe(1);
      expect(strengths.structure).toBe(0.5);
      expect(strengths.trigger).toBe(0.75);
      expect(strengths.volatility).toBe(0.3);
      expect(strengths.execution).toBe(0);
      expect(strengths.sessionMacro).toBe(0.9);
      expect(strengths.reward).toBeCloseTo(0.4, 12);
    }
  });

  it('passes the side to the groups that need it', () => {
    const facts: QualityInputs = {
      ...noFacts,
      trend: { ...noFacts.trend, supertrend: 'UP' },
      structure: { ...noFacts.structure, state5m: 'UP' },
      trigger: { ...noFacts.trigger, macdBars: 3 },
    };
    expect(qualityStrengths('BUY', facts)).toMatchObject({ trend: 1, structure: 1, trigger: 1 });
    expect(qualityStrengths('SELL', facts)).toMatchObject({ trend: 0, structure: 0, trigger: 0 });
  });

  it('feeds a score end to end', () => {
    const facts: QualityInputs = {
      trend: {
        ema20: 4020,
        ema50: 4015,
        ema200: 4000,
        ema50SlopeAtr: 0.5,
        adx: 35,
        plusDI: 30,
        minusDI: 10,
        supertrend: 'UP',
      },
      structure: {
        state15m: 'UP',
        state5m: 'UP',
        breakEvent: 'WITH',
        sweep: null,
        confluence: 2,
        patternMoveR: null,
      },
      trigger: { rangeAtr: 1.6, closeLocation: 0.9, rsiNow: 40, rsiExtreme: 20, macdBars: 3 },
      volatility: { atrPercentile: 50, squeeze: 'RELEASED' },
      execution: { spreadPercentile: 40, stopAtr: 1.4 },
      sessionMacro: { session: 'LONDON', news: { state: 'CLEAR', minutesToNext: null } },
      reward: { tp1Atr: 1.5, levelRoom: 'NONE' },
    };
    const result = scoreQuality(qualityStrengths('BUY', facts), WEIGHTS);
    expect(result.score).toBe(100);
    expect(result.grade).toBe('Very strong');
    expect(scoreQuality(qualityStrengths('SELL', facts), WEIGHTS).score).toBeLessThan(65);
  });
});
