import { describe, expect, it } from 'vitest';

import { planTrade, type PlanInput } from './plan';
import { ATR, BUY_QUOTE, BUY_STOP, DECIDED_AT, flipPrice, flipQuote, planOf } from './test-data';
import { RISK_DEFAULTS, type RiskParams } from './types';

const input = (change: Partial<PlanInput> = {}): PlanInput => ({
  side: 'BUY',
  decidedAt: DECIDED_AT,
  quote: BUY_QUOTE,
  stopLoss: BUY_STOP,
  atr5: ATR,
  structureTarget: null,
  minMeasuredMoveR: null,
  ...change,
});

const plan = (change: Partial<PlanInput> = {}, params: Partial<RiskParams> = {}) => {
  const result = planTrade(input(change), { ...RISK_DEFAULTS, ...params });
  if (!result.ok) throw new Error(`no plan: ${result.reason}`);
  return result.plan;
};

const rejected = (change: Partial<PlanInput> = {}, params: Partial<RiskParams> = {}) => {
  const result = planTrade(input(change), { ...RISK_DEFAULTS, ...params });
  return result.ok ? null : result.reason;
};

describe('the levels of a BUY (the example of docs/02 section 14)', () => {
  const p = plan();

  it('fills at the ask plus the slippage, 0.05 against the trade', () => {
    expect(p.entryRef).toBe(4017.32);
    expect(p.slippage).toBe(0.05);
    expect(p.entry).toBe(4017.37);
  });

  it('measures R from the fill to the stop: 6.47', () => {
    expect(p.stopLoss).toBe(4010.9);
    expect(p.riskDistance).toBe(6.47);
  });

  it('EP1_PARTIAL: TP1 at 1.0 R and TP2 at 2.0 R', () => {
    expect(p.exitProfile).toBe('EP1_PARTIAL');
    expect(p.tp1).toBe(4023.84);
    expect(p.tp2).toBe(4030.31);
  });

  it('puts maxValidEntry above the entry by 0.15 x ATR(5m) when that is less than a quarter of R', () => {
    expect(p.maxValidEntry).toBe(4018.015);
  });

  it('is valid for 3 minutes and has a time stop at 2 hours, from the decision', () => {
    expect(p.entryValidUntil).toBe(DECIDED_AT + 180_000);
    expect(p.timeStopAt).toBe(DECIDED_AT + 7_200_000);
    expect(p.decidedAt).toBe(DECIDED_AT);
  });

  it('has no cost without a commission', () => {
    expect(p.costR).toBe(0);
    expect(p.structureR).toBeNull();
  });
});

describe('maxValidEntry', () => {
  it('is limited to a quarter of R when that is less than 0.15 x ATR', () => {
    // R = 6.4, a quarter is 1.6; 0.15 x 20 would be 3
    const p = plan({ stopLoss: 4010.97, atr5: 20 });
    expect(p.riskDistance).toBe(6.4);
    expect(p.maxValidEntry).toBe(4018.97);
  });

  it('takes both limits from the params', () => {
    expect(plan({}, { maxChaseAtr: 0.3 }).maxValidEntry).toBe(4018.66);
    expect(plan({ stopLoss: 4010.97, atr5: 20 }, { maxChaseRiskFraction: 0.5 }).maxValidEntry).toBe(
      4020.37,
    );
  });

  it('is the entry itself when there is no room to chase', () => {
    expect(plan({}, { maxChaseAtr: 1e-9 }).maxValidEntry).toBe(4017.37);
  });
});

describe('the slippage', () => {
  it('comes from the params and moves the fill, R and every level with it', () => {
    const p = plan({}, { simSlippageUsd: 0.3 });
    expect(p.entry).toBe(4017.62);
    expect(p.riskDistance).toBe(6.72);
    expect(p.tp1).toBe(4024.34);
    expect(p.tp2).toBe(4031.06);
  });

  it('can be zero: the fill is the ask', () => {
    const p = plan({}, { simSlippageUsd: 0 });
    expect(p.entry).toBe(4017.32);
    expect(p.riskDistance).toBe(6.42);
  });
});

describe('the exit profiles', () => {
  it('EP2_SINGLE: one target at 1.5 R', () => {
    const p = plan({}, { exitProfile: 'EP2_SINGLE' });
    expect(p.tp1).toBe(4027.075);
    expect(p.tp2).toBeNull();
  });

  describe('EP3_STRUCTURE: the target at the structure level, bounded to 1.0 R to 3.0 R', () => {
    const at = (structureTarget: number | null) =>
      plan({ structureTarget }, { exitProfile: 'EP3_STRUCTURE' });

    it('uses the level when it is between the bounds', () => {
      const p = at(4026);
      expect(p.tp1).toBe(4026);
      expect(p.tp2).toBeNull();
      expect(p.structureR).toBeCloseTo((4026 - 4017.37) / 6.47, 9);
    });

    it('raises a level that is closer than 1.0 R to 1.0 R, and lowers one beyond 3.0 R to 3.0 R', () => {
      expect(at(4020).tp1).toBe(4023.84);
      expect(at(4050).tp1).toBe(4036.78);
    });

    it('keeps exactly 1.0 R and 3.0 R', () => {
      expect(at(4023.84).tp1).toBe(4023.84);
      expect(at(4036.78).tp1).toBe(4036.78);
    });

    it('a level behind the entry is below the bound too: 1.0 R', () => {
      const p = at(4010);
      expect(p.tp1).toBe(4023.84);
      expect(p.structureR).toBeLessThan(0);
    });

    it('with no level known ahead the target is at 3.0 R', () => {
      expect(at(null).tp1).toBe(4036.78);
    });
  });
});

describe('strategy E: the measured move is checked again with the real entry', () => {
  const ep3: Partial<RiskParams> = { exitProfile: 'EP3_STRUCTURE' };

  it('accepts a target at least 1.5 R away, with the entry of the fill', () => {
    const p = plan({ structureTarget: 4030, minMeasuredMoveR: 1.5 }, ep3);
    expect(p.structureR).toBeCloseTo((4030 - 4017.37) / 6.47, 9);
    expect(p.tp1).toBe(4030);
  });

  it('rejects a target that is closer: 1.4885 R', () => {
    expect(rejected({ structureTarget: 4027, minMeasuredMoveR: 1.5 }, ep3)).toBe(
      'MEASURED_MOVE_TOO_SMALL',
    );
  });

  it('accepts the limit itself, to the last bit of a float', () => {
    // 4017.37 + 1.5 x 6.47 = 4027.075
    expect(plan({ structureTarget: 4027.075, minMeasuredMoveR: 1.5 }, ep3).tp1).toBe(4027.075);
    expect(rejected({ structureTarget: 4027.07, minMeasuredMoveR: 1.5 }, ep3)).toBe(
      'MEASURED_MOVE_TOO_SMALL',
    );
  });

  it('uses the real entry: a bigger slippage makes the same target too close', () => {
    expect(plan({ structureTarget: 4028, minMeasuredMoveR: 1.5 }, ep3).tp1).toBe(4028);
    expect(
      rejected({ structureTarget: 4028, minMeasuredMoveR: 1.5 }, { ...ep3, simSlippageUsd: 0.5 }),
    ).toBe('MEASURED_MOVE_TOO_SMALL');
  });

  it('needs a target: none is too close', () => {
    expect(rejected({ structureTarget: null, minMeasuredMoveR: 1.5 }, ep3)).toBe(
      'MEASURED_MOVE_TOO_SMALL',
    );
  });

  it('applies whatever the exit profile is, and is then bounded by the profile', () => {
    expect(rejected({ structureTarget: 4027, minMeasuredMoveR: 1.5 })).toBe(
      'MEASURED_MOVE_TOO_SMALL',
    );
    const p = plan({ structureTarget: 4050, minMeasuredMoveR: 1.5 }, ep3);
    expect(p.tp1).toBe(4036.78);
    expect(p.structureR).toBeGreaterThan(5);
  });

  it('without a minimum a close target is fine', () => {
    expect(rejected({ structureTarget: 4018 }, ep3)).toBeNull();
  });
});

describe('a stop that is not beyond the entry is no trade', () => {
  it('a BUY whose stop is at or above the fill', () => {
    expect(rejected({ stopLoss: 4017.37 })).toBe('STOP_NOT_BEYOND_ENTRY');
    expect(rejected({ stopLoss: 4018 })).toBe('STOP_NOT_BEYOND_ENTRY');
    expect(rejected({ stopLoss: 4017.36 })).toBeNull();
  });

  it('a stop that is only rounded onto the fill is no trade either', () => {
    expect(rejected({ stopLoss: 4017.3696 })).toBe('STOP_NOT_BEYOND_ENTRY');
  });
});

describe('the costs and the times', () => {
  it('the commission is a share of R', () => {
    expect(plan({}, { commissionUsdPerOz: 0.647 }).costR).toBeCloseTo(0.1, 9);
  });

  it('the validity and the time stop come from the params', () => {
    const p = plan({}, { entryValidSec: 60, timeStopMin: 30 });
    expect(p.entryValidUntil).toBe(DECIDED_AT + 60_000);
    expect(p.timeStopAt).toBe(DECIDED_AT + 1_800_000);
  });

  it('rounds the stop to 3 decimals, and R is taken from the rounded numbers', () => {
    const p = plan({ stopLoss: 4010.9004 });
    expect(p.stopLoss).toBe(4010.9);
    expect(p.riskDistance).toBe(6.47);
    expect(plan({ stopLoss: 4010.9006 }).stopLoss).toBe(4010.901);
  });
});

describe('a SELL is the exact mirror of a BUY', () => {
  const flipped = (change: Partial<PlanInput> = {}, params: Partial<RiskParams> = {}) =>
    plan(
      {
        side: 'SELL',
        quote: flipQuote(BUY_QUOTE),
        stopLoss: flipPrice(BUY_STOP),
        structureTarget:
          change.structureTarget === undefined || change.structureTarget === null
            ? null
            : flipPrice(change.structureTarget),
        minMeasuredMoveR: change.minMeasuredMoveR ?? null,
      },
      params,
    );

  it.each([
    ['EP1_PARTIAL', undefined],
    ['EP2_SINGLE', undefined],
    ['EP3_STRUCTURE', 4026],
    ['EP3_STRUCTURE', 4050],
    ['EP3_STRUCTURE', 4020],
    ['EP3_STRUCTURE', null],
  ] as const)('%s with the target %s', (exitProfile, structureTarget) => {
    const buy = plan({ structureTarget: structureTarget ?? null }, { exitProfile });
    const sell = flipped({ structureTarget: structureTarget ?? null }, { exitProfile });
    expect(sell.side).toBe('SELL');
    expect(sell.entryRef).toBe(flipPrice(4017.32)); // the bid
    expect(sell.entry).toBeCloseTo(flipPrice(buy.entry), 9);
    expect(sell.stopLoss).toBeCloseTo(flipPrice(buy.stopLoss), 9);
    expect(sell.riskDistance).toBeCloseTo(buy.riskDistance, 9);
    expect(sell.maxValidEntry).toBeCloseTo(flipPrice(buy.maxValidEntry), 9);
    expect(sell.tp1).toBeCloseTo(flipPrice(buy.tp1), 9);
    if (buy.tp2 === null) expect(sell.tp2).toBeNull();
    else expect(sell.tp2).toBeCloseTo(flipPrice(buy.tp2), 9);
    if (buy.structureR === null) expect(sell.structureR).toBeNull();
    else expect(sell.structureR).toBeCloseTo(buy.structureR, 9);
    expect(sell.costR).toBe(buy.costR);
    expect(sell.entryValidUntil).toBe(buy.entryValidUntil);
    expect(sell.timeStopAt).toBe(buy.timeStopAt);
  });

  it('fills at the bid minus the slippage, with the stop above and the targets below', () => {
    const sell = flipped();
    expect(sell.entry).toBe(3982.63);
    expect(sell.stopLoss).toBeGreaterThan(sell.entry);
    expect(sell.tp1).toBeLessThan(sell.entry);
    expect(sell.maxValidEntry).toBeLessThan(sell.entry);
  });

  it('rejects a stop at or below the fill, and a close target', () => {
    const quote = flipQuote(BUY_QUOTE);
    const sellInput = (change: Partial<PlanInput>): PlanInput => ({
      side: 'SELL',
      decidedAt: DECIDED_AT,
      quote,
      stopLoss: flipPrice(BUY_STOP),
      atr5: ATR,
      structureTarget: null,
      minMeasuredMoveR: null,
      ...change,
    });
    const reason = (change: Partial<PlanInput>) => {
      const result = planTrade(sellInput(change), {
        ...RISK_DEFAULTS,
        exitProfile: 'EP3_STRUCTURE',
      });
      return result.ok ? null : result.reason;
    };
    expect(reason({ stopLoss: 3982.63 })).toBe('STOP_NOT_BEYOND_ENTRY');
    expect(reason({ stopLoss: 3982 })).toBe('STOP_NOT_BEYOND_ENTRY');
    expect(reason({ stopLoss: 3982.64 })).toBeNull();
    expect(reason({ structureTarget: flipPrice(4027), minMeasuredMoveR: 1.5 })).toBe(
      'MEASURED_MOVE_TOO_SMALL',
    );
    expect(reason({ structureTarget: flipPrice(4030), minMeasuredMoveR: 1.5 })).toBeNull();
  });
});

describe('bad input is refused, not guessed', () => {
  it('needs an ATR above zero', () => {
    expect(() => planOf({}, { atr5: 0 })).toThrow(RangeError);
    expect(() => planOf({}, { atr5: Number.NaN })).toThrow(RangeError);
    expect(() => planOf({}, { atr5: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('needs finite numbers and a quote that makes sense', () => {
    expect(() => planOf({}, { stopLoss: Number.NaN })).toThrow(RangeError);
    expect(() => planOf({}, { decidedAt: Number.NaN })).toThrow(RangeError);
    expect(() => planOf({}, { quote: { t: DECIDED_AT, bid: 4018, ask: 4017 } })).toThrow(
      RangeError,
    );
    expect(() => planOf({}, { quote: { t: DECIDED_AT, bid: 0, ask: 4017 } })).toThrow(RangeError);
    expect(() => planOf({}, { quote: { t: Number.NaN, bid: 4017, ask: 4018 } })).toThrow(
      RangeError,
    );
  });
});
