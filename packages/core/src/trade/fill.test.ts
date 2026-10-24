import { describe, expect, it } from 'vitest';

import { findFill, tradeSpecOf } from './fill';
import { DECIDED_AT, SECOND, flipQuote, planOf, quoteAt } from './test-data';
import { COST_SCENARIOS, RISK_DEFAULTS, type QuoteTick, type RiskParams } from './types';

const params = (change: Partial<RiskParams> = {}) => ({ ...RISK_DEFAULTS, ...change });
const plan = planOf();
// the plan of the example: entry 4017.37, stop 4010.90, maxValidEntry 4018.015, valid until +180 s

/** A quote with the ask at `ask`, `seconds` after the decision. */
const tickAt = (seconds: number, ask: number, spread = 0.12): QuoteTick => ({
  t: DECIDED_AT + seconds * SECOND,
  bid: Math.round((ask - spread) * 1000) / 1000,
  ask,
});

describe('without a delay the fill is the confirming tick', () => {
  it('is the first tick at or after the decision, at the ask plus the slippage', () => {
    const result = findFill(plan, [tickAt(0, 4017.32), tickAt(1, 4018.5)], params());
    expect(result).toMatchObject({ kind: 'FILLED', fillAt: DECIDED_AT, fill: 4017.37 });
    expect(result.kind === 'FILLED' ? result.fill : 0).toBe(plan.entry);
  });

  it('skips ticks from before the decision', () => {
    const result = findFill(
      plan,
      [tickAt(-5, 4016), tickAt(-1, 4016.5), tickAt(2, 4017.4)],
      params(),
    );
    expect(result).toMatchObject({ kind: 'FILLED', fillAt: DECIDED_AT + 2000, fill: 4017.45 });
  });

  it('a tick exactly at the decision counts', () => {
    expect(findFill(plan, [tickAt(0, 4017.4)], params())).toMatchObject({
      kind: 'FILLED',
      fill: 4017.45,
    });
  });
});

describe('with a delay the fill is the first tick at or after the order time', () => {
  const late = params({ execDelaySec: 20 });
  const ticks = [
    tickAt(0, 4017.32),
    tickAt(10, 4017.4),
    tickAt(19.999, 4017.5),
    tickAt(20, 4017.6),
    tickAt(21, 4017.7),
  ];

  it('is the tick exactly at the delay, not the one just before it', () => {
    expect(findFill(plan, ticks, late)).toMatchObject({
      kind: 'FILLED',
      fillAt: DECIDED_AT + 20_000,
      fill: 4017.65,
    });
  });

  it('is the first tick after it when none is exactly at it', () => {
    expect(
      findFill(plan, [tickAt(5, 4017.4), tickAt(23, 4017.6), tickAt(30, 4017.9)], late),
    ).toMatchObject({
      fillAt: DECIDED_AT + 23_000,
      fill: 4017.65,
    });
  });

  it('pays the slippage on top of that ask', () => {
    const fill = findFill(plan, ticks, params({ execDelaySec: 20, simSlippageUsd: 0.3 }));
    expect(fill).toMatchObject({ kind: 'FILLED', fill: 4017.9 });
  });

  it('the delay moves the fill away from the plan, which keeps its R and its levels', () => {
    const filled = findFill(plan, ticks, late);
    if (filled.kind !== 'FILLED') throw new Error('should be filled');
    const spec = tradeSpecOf(plan, filled);
    expect(spec.fill).toBe(4017.65);
    expect(spec.fillAt).toBe(DECIDED_AT + 20_000);
    expect(spec.riskDistance).toBe(plan.riskDistance);
    expect(spec).toMatchObject({
      stopLoss: plan.stopLoss,
      tp1: plan.tp1,
      tp2: plan.tp2,
      timeStopAt: plan.timeStopAt,
      costR: plan.costR,
      side: 'BUY',
      exitProfile: 'EP1_PARTIAL',
    });
  });
});

describe('a delayed price beyond maxValidEntry is skipped', () => {
  const late = params({ execDelaySec: 20 });

  it('skips a fill above it', () => {
    // the ask 4018.0 plus 0.05 is 4018.05, above 4018.015
    expect(findFill(plan, [tickAt(20, 4018)], late)).toMatchObject({
      kind: 'SKIPPED',
      reason: 'BEYOND_MAX_VALID_ENTRY',
    });
  });

  it('takes a fill exactly at it', () => {
    // the ask 4017.965 plus 0.05 is 4018.015
    expect(findFill(plan, [tickAt(20, 4017.965)], late)).toMatchObject({
      kind: 'FILLED',
      fill: 4018.015,
    });
    expect(findFill(plan, [tickAt(20, 4017.966)], late).kind).toBe('SKIPPED');
  });

  it('the slippage counts: the same ask is a skip with a bigger slippage', () => {
    expect(findFill(plan, [tickAt(20, 4017.9)], late).kind).toBe('FILLED');
    expect(
      findFill(plan, [tickAt(20, 4017.9)], params({ execDelaySec: 20, simSlippageUsd: 0.2 })).kind,
    ).toBe('SKIPPED');
  });

  it("a price that went the owner's way is fine: below the entry", () => {
    expect(findFill(plan, [tickAt(20, 4016.5)], late)).toMatchObject({
      kind: 'FILLED',
      fill: 4016.55,
    });
  });

  it('names the tick that made it a skip', () => {
    const tick = tickAt(20, 4019);
    expect(findFill(plan, [tick], late)).toMatchObject({ tick });
  });
});

describe('a price that has already gone through the stop is skipped', () => {
  const late = params({ execDelaySec: 20 });

  it('a fill at or below the stop', () => {
    // 4010.85 + 0.05 = 4010.90 = the stop
    expect(findFill(plan, [tickAt(20, 4010.85)], late)).toMatchObject({
      kind: 'SKIPPED',
      reason: 'BEYOND_STOP',
    });
    expect(findFill(plan, [tickAt(20, 4010.2)], late)).toMatchObject({ reason: 'BEYOND_STOP' });
  });

  it('a fill just above the stop is a trade, with a tiny R', () => {
    expect(findFill(plan, [tickAt(20, 4010.86)], late)).toMatchObject({
      kind: 'FILLED',
      fill: 4010.91,
    });
  });
});

describe('the entry validity', () => {
  it('a delay longer than the validity is expired at once, with no tick', () => {
    expect(findFill(plan, [tickAt(0, 4017.4)], params({ execDelaySec: 181 }))).toEqual({
      kind: 'SKIPPED',
      reason: 'ENTRY_EXPIRED',
      tick: null,
    });
  });

  it('a delay of exactly the validity is allowed, and the tick at that moment is in time', () => {
    expect(findFill(plan, [tickAt(180, 4017.4)], params({ execDelaySec: 180 })).kind).toBe(
      'FILLED',
    );
  });

  it('the first tick after the delay can be too late: it is expired, and it is named', () => {
    const tick = tickAt(185, 4017.4);
    expect(findFill(plan, [tickAt(10, 4017.4), tick], params({ execDelaySec: 20 }))).toEqual({
      kind: 'SKIPPED',
      reason: 'ENTRY_EXPIRED',
      tick,
    });
  });

  it('a tick exactly at the end of the validity is in time', () => {
    expect(findFill(plan, [tickAt(180, 4017.4)], params({ execDelaySec: 20 })).kind).toBe('FILLED');
    expect(findFill(plan, [tickAt(180.001, 4017.4)], params({ execDelaySec: 20 })).kind).toBe(
      'SKIPPED',
    );
  });

  it('the validity comes from the plan', () => {
    const short = planOf({ entryValidSec: 30 });
    expect(findFill(short, [tickAt(40, 4017.4)], params({ execDelaySec: 20 }))).toMatchObject({
      reason: 'ENTRY_EXPIRED',
    });
    expect(findFill(short, [tickAt(30, 4017.4)], params({ execDelaySec: 20 })).kind).toBe('FILLED');
  });

  it('no tick at or after the order time is no fill', () => {
    expect(findFill(plan, [], params())).toEqual({
      kind: 'SKIPPED',
      reason: 'NO_TICK',
      tick: null,
    });
    expect(findFill(plan, [tickAt(0, 4017.4)], params({ execDelaySec: 20 }))).toEqual({
      kind: 'SKIPPED',
      reason: 'NO_TICK',
      tick: null,
    });
  });
});

describe('a SELL fills at the bid minus the slippage, and mirrors the BUY', () => {
  const sellPlan = planOf(
    {},
    {
      side: 'SELL',
      quote: flipQuote({ t: DECIDED_AT, bid: 4017.2, ask: 4017.32 }),
      stopLoss: 3989.1,
    },
  );

  const sellTick = (seconds: number, bid: number): QuoteTick => ({
    t: DECIDED_AT + seconds * SECOND,
    bid,
    ask: Math.round((bid + 0.12) * 1000) / 1000,
  });

  it('fills at the bid of the confirming tick minus the slippage', () => {
    expect(sellPlan.side).toBe('SELL');
    expect(findFill(sellPlan, [sellTick(0, sellPlan.entryRef)], params())).toMatchObject({
      kind: 'FILLED',
      fill: sellPlan.entry,
    });
  });

  it('skips a delayed fill below maxValidEntry, and takes one exactly at it', () => {
    const late = params({ execDelaySec: 20 });
    const limit = sellPlan.maxValidEntry;
    expect(limit).toBeLessThan(sellPlan.entry);
    expect(findFill(sellPlan, [sellTick(20, limit + 0.05)], late)).toMatchObject({
      kind: 'FILLED',
      fill: limit,
    });
    expect(findFill(sellPlan, [sellTick(20, limit + 0.04)], late)).toMatchObject({
      reason: 'BEYOND_MAX_VALID_ENTRY',
    });
  });

  it('skips a price that has already gone through the stop above', () => {
    const late = params({ execDelaySec: 20 });
    expect(findFill(sellPlan, [sellTick(20, 3989.15)], late)).toMatchObject({
      reason: 'BEYOND_STOP',
    });
    expect(findFill(sellPlan, [sellTick(20, 3989.0)], late).kind).toBe('FILLED');
  });
});

describe('ticks and quotes are checked', () => {
  it('ticks must be in time order, even those that are skipped', () => {
    expect(() =>
      findFill(plan, [tickAt(10, 4017.4), tickAt(5, 4017.4)], params({ execDelaySec: 20 })),
    ).toThrow(RangeError);
  });

  it('a quote must make sense', () => {
    expect(() => findFill(plan, [{ t: DECIDED_AT, bid: 4018, ask: 4017 }], params())).toThrow(
      RangeError,
    );
  });

  it('two ticks at the same time are fine', () => {
    const ticks = [tickAt(-5, 4016), tickAt(-5, 4016.5), tickAt(0, 4017.4), tickAt(0, 4017.5)];
    expect(findFill(plan, ticks, params())).toMatchObject({ kind: 'FILLED', fill: 4017.45 });
  });
});

describe('the cost scenarios of docs/02 section 15', () => {
  it('A is the baseline, B a bad fill, C a late fill', () => {
    expect(COST_SCENARIOS).toEqual({
      A: { simSlippageUsd: 0.05, execDelaySec: 0 },
      B: { simSlippageUsd: 0.3, execDelaySec: 0 },
      C: { simSlippageUsd: 0.05, execDelaySec: 20 },
    });
  });

  it('A is the default model', () => {
    expect(RISK_DEFAULTS).toMatchObject(COST_SCENARIOS.A);
  });
});

describe('quoteAt helper', () => {
  it('builds a quote around a mid', () => {
    expect(quoteAt(5, 4000)).toEqual({ t: DECIDED_AT + 5000, bid: 3999.94, ask: 4000.06 });
  });
});
