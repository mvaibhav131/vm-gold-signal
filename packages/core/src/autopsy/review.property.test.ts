import { describe, expect, it } from 'vitest';

import { CAUSE_CODES, REGIMES, type CauseCode } from '../domain';
import { flipPrice } from '../trade/test-data';
import type { TradeOutcome } from '../trade/types';
import { reviewTrade } from './review';
import { CAUSE_PRIORITY } from './rules';
import { FILL_AT, MIN, TRADE, mirror, outcomeOf, strongGroups } from './test-data';
import type { AfterCandle, HighImpactSeen, Review, ReviewInput, StructureBreakSeen } from './types';

/** A small seeded source, so that a failure can be replayed from its number. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value: number, decimals: number) => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale + 0;
};

/** A random trade that ends as a loss, a partial win or a losing time exit, with a random market around it. */
function scenario(seed: number): ReviewInput {
  const rand = random(seed * 7919 + 17);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const risk = round(3 + rand() * 9, 2);
  const atr5 = round(2 + rand() * 4, 2);
  const fill = 4017.37;
  const fillAt = Date.UTC(2026, 9, 23, 0, 0) + Math.floor(rand() * 21 * 60) * MIN;
  const kind = pick(['LOSS', 'LOSS', 'PARTIAL_WIN', 'TIME_EXIT'] as const);
  const minutes = 5 + Math.floor(rand() * 140);
  const closedAt = fillAt + minutes * MIN;

  let outcome: TradeOutcome;
  if (kind === 'LOSS') {
    const exitR = -(1 + (rand() < 0.3 ? rand() * 0.6 : 0));
    const mfeR = round(rand() < 0.5 ? rand() * 0.35 : rand() * 1.5, 3);
    outcome = outcomeOf(
      'LOSS',
      minutes,
      {
        exitPrice: round(fill + exitR * risk, 3),
        realizedRNet: round(exitR - 0.04, 3),
        costR: round(rand() < 0.2 ? rand() * 0.3 : 0.04, 3),
        mfeR,
        maeR: round(Math.min(exitR, -rand() * 1.2 - 0.2), 3),
      },
      fillAt,
    );
  } else if (kind === 'PARTIAL_WIN') {
    outcome = outcomeOf(
      'PARTIAL_WIN',
      minutes,
      {
        exitPrice: fill,
        exitReason: 'STOP_AT_ENTRY',
        realizedRNet: round(0.46, 3),
        mfeR: round(1 + rand() * 1.4, 3),
        maeR: round(-rand() * 0.4, 3),
        tp1Hit: true,
        isWin: true,
      },
      fillAt,
    );
  } else {
    const exitR = -rand() * 0.9;
    outcome = outcomeOf(
      'TIME_EXIT',
      minutes,
      {
        exitPrice: round(fill + exitR * risk, 3),
        exitReason: 'TIME_STOP',
        realizedRNet: round(exitR, 3),
        mfeR: round(rand() * 0.9, 3),
        maeR: round(Math.min(exitR, -rand() * 1.2), 3),
      },
      fillAt,
    );
  }

  const breaks: StructureBreakSeen[] = Array.from({ length: Math.floor(rand() * 3) }, () => ({
    tf: pick(['15m', '1h'] as const),
    direction: pick(['UP', 'DOWN'] as const),
    at: fillAt + Math.floor((rand() * 1.2 - 0.1) * minutes * MIN),
    level: round(fill - 15 + rand() * 30, 2),
  }));
  const events: HighImpactSeen[] = Array.from({ length: Math.floor(rand() * 2.4) }, () => ({
    kind: pick(['EVENT', 'HEADLINE'] as const),
    name: `item ${String(Math.floor(rand() * 100))}`,
    at: fillAt + Math.floor((rand() * 1.3 - 0.15) * minutes * MIN),
  }));

  const first = Math.ceil(closedAt / (5 * MIN)) * 5 * MIN;
  const count = pick([null, 0, 6, 12, 14] as const);
  let afterCandles: AfterCandle[] | null = null;
  if (count !== null) {
    afterCandles = [];
    for (let i = 0; i < count; i += 1) {
      if (rand() < 0.04) continue; // a hole
      const mid = fill + (rand() * 2 - 0.6) * risk;
      afterCandles.push({
        openTime: first + i * 5 * MIN,
        high: round(mid + rand() * risk * 0.5, 3),
        low: round(mid - rand() * risk * 0.5, 3),
      });
    }
  }

  return {
    trade: {
      ...TRADE,
      fill,
      fillAt,
      riskDistance: risk,
      tp1: round(fill + risk, 3),
      tp2: rand() < 0.7 ? round(fill + 2 * risk, 3) : null,
      atr5,
      spreadAtEntry: rand() < 0.1 ? null : round(0.05 + rand() * (rand() < 0.15 ? 2.5 : 0.3), 3),
      slippageUsd: 0.05,
      regime: pick(REGIMES),
      groups: strongGroups({
        trend: pick(['STRONG', 'OK', 'WEAK', 'FAIL', 'NA'] as const),
        reward: pick(['STRONG', 'WEAK', 'FAIL'] as const),
      }),
    },
    outcome,
    course: {
      regimeAtClose: rand() < 0.1 ? null : pick(REGIMES),
      structureBreaks: breaks,
      highImpact: events,
      atrRatioMax: rand() < 0.2 ? null : round(0.8 + rand() * 3, 2),
    },
    afterCandles,
  };
}

/** The part of a review that must not depend on the side: the level of a break is a price, so it is compared apart. */
function sideFree(review: Review) {
  return {
    ...review,
    causes: review.causes.map((cause) => ({
      code: cause.code,
      evidence:
        cause.code === 'HTF_STRUCTURE_BREAK' ? { ...cause.evidence, level: null } : cause.evidence,
    })),
  };
}

const SCENARIOS = 3000;

describe('a review follows the rules, over random trades and markets', () => {
  const seen = new Map<CauseCode, number>();
  const primary = new Map<CauseCode, number>();
  let finals = 0;

  it('keeps its invariants for every trade', () => {
    for (let seed = 0; seed < SCENARIOS; seed += 1) {
      const input = scenario(seed);
      const result = reviewTrade(input);
      const label = `scenario ${String(seed)}`;

      expect(result.causes.length, label).toBeGreaterThan(0);
      expect(result.primaryCause, label).toBe(result.causes[0]?.code);
      const codes = result.causes.map((cause) => cause.code);
      expect(new Set(codes).size, label).toBe(codes.length);
      const order = codes.map((code) => CAUSE_PRIORITY.indexOf(code));
      expect(
        [...order].sort((a, b) => a - b),
        label,
      ).toEqual(order);
      if (codes.includes('NORMAL_LOSS')) expect(codes, label).toEqual(['NORMAL_LOSS']);
      expect(result.status, label).toBe(input.afterCandles === null ? 'PRELIMINARY' : 'FINAL');
      if (input.afterCandles === null) expect(result.counterfactual, label).toBeNull();
      if (input.outcome.result !== 'LOSS') expect(codes, label).not.toContain('STOP_HUNT_REVERSAL');
      if (input.outcome.result !== 'TIME_EXIT') expect(codes, label).not.toContain('TIME_DECAY');
      if (input.outcome.result === 'PARTIAL_WIN')
        expect(codes, label).not.toContain('NO_FOLLOW_THROUGH');
      // what is stored must be JSON, so no undefined and no number that is not finite
      expect(JSON.parse(JSON.stringify(result)), label).toEqual(result);

      for (const code of codes) seen.set(code, (seen.get(code) ?? 0) + 1);
      primary.set(result.primaryCause, (primary.get(result.primaryCause) ?? 0) + 1);
      if (result.status === 'FINAL') finals += 1;
    }
  });

  it('reaches every cause, and every cause as the primary one, many times', () => {
    for (const code of CAUSE_CODES) {
      expect(seen.get(code) ?? 0, `${code} applies`).toBeGreaterThanOrEqual(30);
      expect(primary.get(code) ?? 0, `${code} is primary`).toBeGreaterThanOrEqual(5);
    }
    expect(finals).toBeGreaterThan(SCENARIOS / 2);
  });
});

describe('a SELL is the exact mirror of a BUY', () => {
  it('has the same causes, numbers and counterfactual for every random trade', () => {
    let compared = 0;
    for (let seed = 0; seed < SCENARIOS; seed += 1) {
      const buy = scenario(seed);
      const sell = mirror(buy);
      const a = reviewTrade(buy);
      const b = reviewTrade(sell);
      const label = `scenario ${String(seed)}`;
      expect(sideFree(b), label).toEqual(sideFree(a));
      const breakA = a.causes.find((cause) => cause.code === 'HTF_STRUCTURE_BREAK');
      const breakB = b.causes.find((cause) => cause.code === 'HTF_STRUCTURE_BREAK');
      if (breakA !== undefined && breakB !== undefined) {
        expect(breakB.evidence.level, label).toBe(flipPrice(Number(breakA.evidence.level)));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('is its own mirror image twice', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const buy = scenario(seed);
      expect(reviewTrade(mirror(mirror(buy)))).toEqual(reviewTrade(buy));
    }
  });

  it('starts from a BUY at the example fill', () => {
    expect(FILL_AT).toBeGreaterThan(0);
    expect(scenario(1).trade.side).toBe('BUY');
    expect(mirror(scenario(1)).trade.side).toBe('SELL');
  });
});
