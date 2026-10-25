import { describe, expect, it } from 'vitest';

import { CAUSE_CODES, QUALITY_GROUPS } from '../domain';
import { reviewTrade, needsReview } from './review';
import { CAUSE_PRIORITY } from './rules';
import {
  COURSE,
  FILL_AT,
  LOSS,
  MIN,
  PARTIAL,
  TIME_EXIT,
  TRADE,
  breakSeen,
  candlesAfter,
  courseWith,
  outcomeOf,
  review,
  strongGroups,
} from './test-data';
import type { ReviewInput, ReviewedTrade } from './types';

const codes = (input: ReviewInput) => reviewTrade(input).causes.map((cause) => cause.code);
const evidenceOf = (input: ReviewInput, code: (typeof CAUSE_CODES)[number]) =>
  reviewTrade(input).causes.find((cause) => cause.code === code)?.evidence;

describe('the trade of the example has no cause: it is a normal loss', () => {
  it('is NORMAL_LOSS, with the best and the worst move as its numbers', () => {
    expect(reviewTrade(review())).toEqual({
      status: 'PRELIMINARY',
      primaryCause: 'NORMAL_LOSS',
      causes: [{ code: 'NORMAL_LOSS', evidence: { maxFavourableR: 0.5, maxAdverseR: -1 } }],
      weakGroupsAtEntry: [],
      counterfactual: null,
    });
  });

  it('is the same every time', () => {
    expect(reviewTrade(review())).toEqual(reviewTrade(review()));
  });
});

describe('NO_FOLLOW_THROUGH: the best move in favour was below 0.3 R', () => {
  const withMfe = (mfeR: number | null, outcome = LOSS) =>
    review({ outcome: { ...outcome, mfeR } });

  it('applies at 0.299 R, with the number and the limit', () => {
    expect(codes(withMfe(0.299))).toEqual(['NO_FOLLOW_THROUGH']);
    expect(evidenceOf(withMfe(0.299), 'NO_FOLLOW_THROUGH')).toEqual({
      maxFavourableR: 0.299,
      limitR: 0.3,
    });
  });

  it('does not apply at exactly 0.3 R, or above', () => {
    expect(codes(withMfe(0.3))).toEqual(['NORMAL_LOSS']);
    expect(codes(withMfe(0.301))).toEqual(['NORMAL_LOSS']);
  });

  it('applies when price never moved in favour at all', () => {
    expect(codes(withMfe(0))).toEqual(['NO_FOLLOW_THROUGH']);
  });

  it('applies to a time exit as well', () => {
    expect(codes(withMfe(0.1, TIME_EXIT))).toEqual(['NO_FOLLOW_THROUGH', 'TIME_DECAY']);
  });

  it('cannot apply to a partial win: TP1 was reached', () => {
    expect(codes(review({ outcome: PARTIAL }))).not.toContain('NO_FOLLOW_THROUGH');
  });

  it('is not guessed when the best move is not known', () => {
    expect(codes(withMfe(null))).toEqual(['NORMAL_LOSS']);
  });

  it('takes another limit from the parameters', () => {
    const input = withMfe(0.4);
    expect(reviewTrade(input).primaryCause).toBe('NORMAL_LOSS');
    const strict = reviewTrade(input, {
      noFollowThroughR: 0.5,
      counterfactualCandles: 12,
      newsShockAdverseAtr: 1.5,
      newsShockAtrRatio: 2.5,
      liquidityDropMinutes: 30,
      spreadCostShare: 0.25,
    });
    expect(strict.primaryCause).toBe('NO_FOLLOW_THROUGH');
  });
});

describe('STOP_HUNT_REVERSAL: after the stop-out, price reached TP1 within 12 candles', () => {
  const closedAt = LOSS.closedAt;
  const withCandles = (reachAt: number | null, count = 12) =>
    review({ afterCandles: candlesAfter(closedAt, reachAt, TRADE.tp1, count) });

  it('applies in the final review, with the candles it took', () => {
    const final = reviewTrade(withCandles(3));
    expect(final.status).toBe('FINAL');
    expect(final.primaryCause).toBe('STOP_HUNT_REVERSAL');
    expect(final.causes).toEqual([
      { code: 'STOP_HUNT_REVERSAL', evidence: { candlesToTp1AfterStop: 3, limitCandles: 12 } },
    ]);
    expect(final.counterfactual).toEqual({
      reachedTp1: true,
      candlesToTp1: 3,
      reachedTp2: false,
      candlesToTp2: null,
    });
  });

  it('applies from the first candle to the twelfth, and not after', () => {
    for (const reachAt of [1, 12]) {
      expect(reviewTrade(withCandles(reachAt)).primaryCause, String(reachAt)).toBe(
        'STOP_HUNT_REVERSAL',
      );
    }
    const late = review({
      afterCandles: [...candlesAfter(closedAt, null), ...candlesAfter(closedAt + 12 * 5 * MIN, 1)],
    });
    expect(codes(late)).toEqual(['NORMAL_LOSS']);
  });

  it('cannot be seen at the close: the preliminary review has no counterfactual', () => {
    const preliminary = reviewTrade(review());
    expect(preliminary.status).toBe('PRELIMINARY');
    expect(preliminary.counterfactual).toBeNull();
    expect(preliminary.causes.map((cause) => cause.code)).not.toContain('STOP_HUNT_REVERSAL');
  });

  it('is not claimed when the window is not fully seen', () => {
    const short = reviewTrade(withCandles(null, 6));
    expect(short.status).toBe('FINAL');
    expect(short.counterfactual).toBeNull();
    expect(short.primaryCause).toBe('NORMAL_LOSS');
    expect(reviewTrade(review({ afterCandles: [] })).counterfactual).toBeNull();
  });

  it('is a stop-out only: not a time exit and not a stop at the entry after TP1', () => {
    const candles = candlesAfter(TIME_EXIT.closedAt, 2);
    expect(codes(review({ outcome: TIME_EXIT, afterCandles: candles }))).toEqual(['TIME_DECAY']);
    const partial = candlesAfter(PARTIAL.closedAt, 2);
    expect(codes(review({ outcome: PARTIAL, afterCandles: partial }))).toEqual(['NORMAL_LOSS']);
  });

  it('is the primary cause over the others that apply', () => {
    const noFollow = review({
      outcome: { ...LOSS, mfeR: 0.2 },
      afterCandles: candlesAfter(closedAt, 5),
    });
    expect(codes(noFollow)).toEqual(['STOP_HUNT_REVERSAL', 'NO_FOLLOW_THROUGH']);
  });
});

describe('NEWS_SHOCK: an event or a volatility shock and a move of 1.5 ATR against the position', () => {
  const event = (at: number, name = 'US CPI') => ({ kind: 'EVENT' as const, name, at });
  const headline = (at: number, name = 'Missile strike reported') => ({
    kind: 'HEADLINE' as const,
    name,
    at,
  });
  const shock = (
    highImpact: ReviewInput['course']['highImpact'],
    atrRatioMax: number | null = 1.1,
  ) => review({ course: courseWith({ highImpact, atrRatioMax }) });

  // the example loss went 1.5 R against the position: 1.5 x 6.47 / 4.3 = 2.26 ATR
  it('applies for an event during the trade, with what it saw', () => {
    const input = shock([event(FILL_AT + 7 * MIN)]);
    expect(codes(input)).toEqual(['NEWS_SHOCK']);
    expect(evidenceOf(input, 'NEWS_SHOCK')).toEqual({
      trigger: 'EVENT',
      name: 'US CPI',
      atrVersusMedian: 1.1,
      adverseMoveAtr: 2.26,
    });
  });

  it('applies for a headline during the trade', () => {
    expect(evidenceOf(shock([headline(FILL_AT + 3 * MIN)]), 'NEWS_SHOCK')).toMatchObject({
      trigger: 'HEADLINE',
      name: 'Missile strike reported',
    });
  });

  it('counts the first and the last minute of the trade, and nothing outside it', () => {
    expect(codes(shock([event(FILL_AT)]))).toContain('NEWS_SHOCK');
    expect(codes(shock([event(LOSS.closedAt)]))).toContain('NEWS_SHOCK');
    expect(codes(shock([event(FILL_AT - 1)]))).not.toContain('NEWS_SHOCK');
    expect(codes(shock([event(LOSS.closedAt + 1)]))).not.toContain('NEWS_SHOCK');
  });

  it('names the earliest of several, and cuts a long name', () => {
    const input = shock([
      event(FILL_AT + 9 * MIN, 'second'),
      headline(FILL_AT + 2 * MIN, 'x'.repeat(200)),
    ]);
    const evidence = evidenceOf(input, 'NEWS_SHOCK');
    expect(evidence).toMatchObject({ trigger: 'HEADLINE' });
    expect(String(evidence?.name)).toHaveLength(80);
  });

  it('applies for a volatility shock with no event: ATR 2.5 times its median, and no name', () => {
    expect(evidenceOf(shock([], 2.5), 'NEWS_SHOCK')).toEqual({
      trigger: 'VOLATILITY',
      name: null,
      atrVersusMedian: 2.5,
      adverseMoveAtr: 2.26,
    });
    expect(codes(shock([], 2.49))).toEqual(['NORMAL_LOSS']);
    expect(codes(shock([], null))).toEqual(['NORMAL_LOSS']);
  });

  it('needs a trigger: a big move alone is not a news shock', () => {
    expect(codes(shock([]))).toEqual(['NORMAL_LOSS']);
  });

  it('rounds the volatility versus its median to 2 decimals', () => {
    expect(evidenceOf(shock([], 2.847), 'NEWS_SHOCK')).toMatchObject({ atrVersusMedian: 2.85 });
  });

  it('needs the move: an event and a small move against the position is not a shock', () => {
    const small = review({
      outcome: { ...TIME_EXIT, mfeR: 0.2, maeR: -0.3, exitPrice: 4017.37 - 0.3 * 6.47 },
      course: courseWith({ highImpact: [event(FILL_AT + 7 * MIN)] }),
    });
    expect(codes(small)).not.toContain('NEWS_SHOCK');
  });

  describe('the boundary of 1.5 ATR', () => {
    // risk 6 and ATR 4: a loss of exactly 1 R is 1.5 ATR
    const trade: ReviewedTrade = { ...TRADE, riskDistance: 6, atr5: 4 };
    const stopped = outcomeOf('LOSS', 15, {
      exitPrice: TRADE.fill - 6,
      realizedRNet: -1,
      costR: 0,
      mfeR: 0,
      maeR: -1,
    });
    const at = (atr5: number) =>
      review({
        trade: { ...trade, atr5 },
        outcome: stopped,
        course: courseWith({ highImpact: [event(FILL_AT + 5 * MIN)] }),
      });

    it('applies at exactly 1.5 ATR and not just below it', () => {
      expect(codes(at(4))).toContain('NEWS_SHOCK');
      expect(codes(at(4.01))).not.toContain('NEWS_SHOCK');
    });
  });

  describe('the move against the position', () => {
    it('is the worse of the lowest point and the give-back from the best point to the exit', () => {
      // lowest point -0.2 R, but price fell from +1.2 R to the entry: 1.2 R back = 1.8 ATR at R 6 / ATR 4
      const partial = review({
        trade: { ...TRADE, riskDistance: 6, atr5: 4 },
        outcome: { ...PARTIAL, mfeR: 1.2, maeR: -0.2, exitPrice: TRADE.fill },
        course: courseWith({ highImpact: [event(FILL_AT + 20 * MIN)] }),
      });
      expect(evidenceOf(partial, 'NEWS_SHOCK')).toMatchObject({ adverseMoveAtr: 1.8 });
      // the lowest point (-1.4 R) is deeper than the give-back (0.1 R to -0.2 R is 0.3 R)
      const exitedHigher = review({
        trade: { ...TRADE, riskDistance: 6, atr5: 4 },
        outcome: { ...TIME_EXIT, mfeR: 0.1, maeR: -1.4, exitPrice: TRADE.fill - 1.2 },
        course: courseWith({ highImpact: [event(FILL_AT + 5 * MIN)] }),
      });
      expect(evidenceOf(exitedHigher, 'NEWS_SHOCK')).toMatchObject({ adverseMoveAtr: 2.1 });
      // a stop-out at the lowest point: the give-back from the best point is the larger
      const loss = review({
        trade: { ...TRADE, riskDistance: 6, atr5: 4 },
        outcome: { ...LOSS, mfeR: 0.1, maeR: -1.4, exitPrice: TRADE.fill - 8.4 },
        course: courseWith({ highImpact: [event(FILL_AT + 5 * MIN)] }),
      });
      expect(evidenceOf(loss, 'NEWS_SHOCK')).toMatchObject({ adverseMoveAtr: 2.25 });
    });
  });
});

describe('HTF_STRUCTURE_BREAK: a 15m or 1h change of character against the position', () => {
  const withBreaks = (breaks: ReturnType<typeof breakSeen>[], input: Partial<ReviewInput> = {}) =>
    review({ course: courseWith({ structureBreaks: breaks }), ...input });

  it('applies for a bearish change against a BUY, with the number it saw', () => {
    const input = withBreaks([breakSeen()]);
    expect(codes(input)).toEqual(['HTF_STRUCTURE_BREAK']);
    expect(evidenceOf(input, 'HTF_STRUCTURE_BREAK')).toEqual({
      timeframe: '15m',
      level: 4012.1,
      minutesIntoTrade: 10,
      breaks: 1,
    });
  });

  it('does not apply for a change with the position', () => {
    expect(codes(withBreaks([breakSeen({ direction: 'UP' })]))).toEqual(['NORMAL_LOSS']);
  });

  it('rounds the minutes into the trade to the nearest one', () => {
    const input = withBreaks([breakSeen({ at: FILL_AT + 100_000 })]);
    expect(evidenceOf(input, 'HTF_STRUCTURE_BREAK')).toMatchObject({ minutesIntoTrade: 2 });
  });

  it('is a bullish change against a SELL', () => {
    const sell: ReviewedTrade = { ...TRADE, side: 'SELL' };
    const sellLoss = { ...LOSS, exitPrice: 4023.84 };
    expect(
      codes(withBreaks([breakSeen({ direction: 'UP' })], { trade: sell, outcome: sellLoss })),
    ).toEqual(['HTF_STRUCTURE_BREAK']);
    expect(
      codes(withBreaks([breakSeen({ direction: 'DOWN' })], { trade: sell, outcome: sellLoss })),
    ).toEqual(['NORMAL_LOSS']);
  });

  it('applies for a 1h change, and takes the earliest of several', () => {
    const input = withBreaks([
      breakSeen({ tf: '1h', at: FILL_AT + 12 * MIN, level: 4011 }),
      breakSeen({ at: FILL_AT + 6 * MIN, level: 4013 }),
    ]);
    expect(evidenceOf(input, 'HTF_STRUCTURE_BREAK')).toEqual({
      timeframe: '15m',
      level: 4013,
      minutesIntoTrade: 6,
      breaks: 2,
    });
    expect(evidenceOf(withBreaks([breakSeen({ tf: '1h' })]), 'HTF_STRUCTURE_BREAK')).toMatchObject({
      timeframe: '1h',
    });
  });

  it('is only a change between the fill and the exit, the exit included', () => {
    expect(codes(withBreaks([breakSeen({ at: FILL_AT })]))).toEqual(['NORMAL_LOSS']);
    expect(codes(withBreaks([breakSeen({ at: FILL_AT - 5 * MIN })]))).toEqual(['NORMAL_LOSS']);
    expect(codes(withBreaks([breakSeen({ at: FILL_AT + 1 })]))).toEqual(['HTF_STRUCTURE_BREAK']);
    expect(codes(withBreaks([breakSeen({ at: LOSS.closedAt })]))).toEqual(['HTF_STRUCTURE_BREAK']);
    expect(codes(withBreaks([breakSeen({ at: LOSS.closedAt + 1 })]))).toEqual(['NORMAL_LOSS']);
  });

  it('counts a change after TP1 for a partial win', () => {
    const input = withBreaks([breakSeen({ at: FILL_AT + 25 * MIN })], { outcome: PARTIAL });
    expect(codes(input)).toEqual(['HTF_STRUCTURE_BREAK']);
  });
});

describe('REGIME_SHIFT: the regime at the close is another than at entry', () => {
  const closeIn = (regimeAtClose: ReviewInput['course']['regimeAtClose']) =>
    review({ course: courseWith({ regimeAtClose }) });

  it('applies, with both regimes', () => {
    expect(codes(closeIn('RANGE'))).toEqual(['REGIME_SHIFT']);
    expect(evidenceOf(closeIn('RANGE'), 'REGIME_SHIFT')).toEqual({
      regimeAtEntry: 'TREND_UP',
      regimeAtClose: 'RANGE',
    });
  });

  it('applies for any other regime, the opposite trend included', () => {
    for (const regime of ['TREND_DOWN', 'SQUEEZE', 'BREAKOUT', 'HIGH_VOL', 'UNCERTAIN'] as const) {
      expect(codes(closeIn(regime)), regime).toEqual(['REGIME_SHIFT']);
    }
  });

  it('does not apply for the same regime, or when the regime is not known', () => {
    expect(codes(closeIn('TREND_UP'))).toEqual(['NORMAL_LOSS']);
    expect(codes(closeIn(null))).toEqual(['NORMAL_LOSS']);
  });
});

describe('LIQUIDITY_DROP: closed in rollover or in the last 30 minutes of the open markets', () => {
  // Friday 23 October 2026: London is on summer time (open 07:00-15:30 UTC) and New York too (12:00-21:00 UTC).
  const closedAtUtc = (hour: number, minute: number) => {
    const closedAt = Date.UTC(2026, 9, 23, hour, minute);
    const fillAt = closedAt - 15 * MIN;
    return review({
      trade: { ...TRADE, fillAt },
      outcome: { ...LOSS, closedAt },
      course: COURSE,
    });
  };

  it('applies in rollover', () => {
    expect(codes(closedAtUtc(22, 0))).toEqual(['LIQUIDITY_DROP']);
    expect(evidenceOf(closedAtUtc(22, 0), 'LIQUIDITY_DROP')).toEqual({ session: 'ROLLOVER' });
  });

  it('applies in the quiet hours after New York closes, which count as rollover', () => {
    expect(codes(closedAtUtc(21, 30))).toEqual(['LIQUIDITY_DROP']);
  });

  it('applies in the last 30 minutes of New York, when London has closed', () => {
    expect(evidenceOf(closedAtUtc(20, 40), 'LIQUIDITY_DROP')).toEqual({
      session: 'NEW_YORK',
      minutesBeforeSessionEnd: 20,
    });
    expect(codes(closedAtUtc(20, 30))).toEqual(['LIQUIDITY_DROP']);
    expect(codes(closedAtUtc(20, 29))).toEqual(['NORMAL_LOSS']);
    expect(codes(closedAtUtc(20, 59))).toEqual(['LIQUIDITY_DROP']);
  });

  it('rounds the minutes left to the nearest one', () => {
    const closedAt = Date.UTC(2026, 9, 23, 20, 40, 30);
    const input = review({
      trade: { ...TRADE, fillAt: closedAt - 15 * MIN },
      outcome: { ...LOSS, closedAt },
    });
    expect(evidenceOf(input, 'LIQUIDITY_DROP')).toMatchObject({ minutesBeforeSessionEnd: 20 });
  });

  describe('in winter time', () => {
    // 14 January 2026: London is on UTC (open 08:00-16:30 UTC), New York on EST (open 13:00-22:00 UTC)
    const winter = (hour: number, minute: number) => {
      const closedAt = Date.UTC(2026, 0, 14, hour, minute);
      return review({
        trade: { ...TRADE, fillAt: closedAt - 15 * MIN },
        outcome: { ...LOSS, closedAt },
      });
    };

    it('applies in the last 30 minutes of New York, which close at 22:00 UTC', () => {
      expect(evidenceOf(winter(21, 30), 'LIQUIDITY_DROP')).toEqual({
        session: 'NEW_YORK',
        minutesBeforeSessionEnd: 30,
      });
      expect(codes(winter(21, 29))).toEqual(['NORMAL_LOSS']);
    });

    it('does not apply when London closes while New York is still open', () => {
      expect(codes(winter(16, 20))).toEqual(['NORMAL_LOSS']);
    });
  });

  it('does not apply when one of the open markets is far from its close', () => {
    // 15:20 UTC: London closes in 10 minutes but New York has 5 hours 40 minutes left
    expect(codes(closedAtUtc(15, 20))).toEqual(['NORMAL_LOSS']);
  });

  it('does not apply in the Asia session or in the middle of the day', () => {
    expect(codes(closedAtUtc(3, 0))).toEqual(['NORMAL_LOSS']);
    expect(codes(closedAtUtc(13, 0))).toEqual(['NORMAL_LOSS']);
  });

  it('is read at the time of the exit, not of the entry', () => {
    const closedAt = Date.UTC(2026, 9, 23, 20, 40);
    const input = review({
      trade: { ...TRADE, fillAt: Date.UTC(2026, 9, 23, 18, 0) },
      outcome: { ...LOSS, closedAt },
    });
    expect(codes(input)).toEqual(['LIQUIDITY_DROP']);
  });
});

describe('SPREAD_COST: spread, slippage and commission were 25% of the risk distance', () => {
  // risk 4: a spread of 0.9 and a slippage of 0.1 are exactly 1.0 USD, a quarter of it
  const tight = (spreadAtEntry: number | null, slippageUsd: number, costR = 0): ReviewInput =>
    review({
      trade: { ...TRADE, riskDistance: 4, spreadAtEntry, slippageUsd },
      outcome: { ...LOSS, exitPrice: TRADE.fill - 4, costR, realizedRNet: -1 - costR },
    });

  it('applies at exactly 25%, with the cost and its share', () => {
    expect(codes(tight(0.9, 0.1))).toEqual(['SPREAD_COST']);
    expect(evidenceOf(tight(0.9, 0.1), 'SPREAD_COST')).toEqual({ costUsd: 1, shareOfRisk: 0.25 });
  });

  it('rounds the cost and its share to 3 decimals', () => {
    // 0.9137 + 0.1 = 1.0137 USD, which is 0.2534 of a risk of 4
    expect(evidenceOf(tight(0.9137, 0.1), 'SPREAD_COST')).toEqual({
      costUsd: 1.014,
      shareOfRisk: 0.253,
    });
  });

  it('does not apply just below it', () => {
    expect(codes(tight(0.89, 0.1))).toEqual(['NORMAL_LOSS']);
  });

  it('counts the commission, which the outcome keeps as R', () => {
    // 0.8 + 0.1 = 0.9 USD, and 0.025 R x 4 = 0.1 USD of commission
    expect(codes(tight(0.8, 0.1, 0.025))).toEqual(['SPREAD_COST']);
    expect(codes(tight(0.8, 0.1, 0.02))).toEqual(['NORMAL_LOSS']);
  });

  it('counts the slippage', () => {
    expect(codes(tight(0.5, 0.5))).toEqual(['SPREAD_COST']);
    expect(codes(tight(0.5, 0.3))).toEqual(['NORMAL_LOSS']);
  });

  it('cannot be raised by a spread that is not known', () => {
    expect(codes(tight(null, 0.1))).toEqual(['NORMAL_LOSS']);
    expect(codes(tight(null, 1))).toEqual(['SPREAD_COST']);
  });

  it('is rare with the example: 7% of the risk', () => {
    expect(codes(review())).toEqual(['NORMAL_LOSS']);
  });
});

describe('TIME_DECAY: a time exit that did not make money', () => {
  it('applies, with the net R and the minutes in the trade', () => {
    expect(codes(review({ outcome: TIME_EXIT }))).toEqual(['TIME_DECAY']);
    expect(evidenceOf(review({ outcome: TIME_EXIT }), 'TIME_DECAY')).toEqual({
      netR: -0.18,
      minutesInTrade: 120,
    });
  });

  it('applies at exactly zero', () => {
    const flat = review({ outcome: { ...TIME_EXIT, realizedRNet: 0, exitPrice: TRADE.fill } });
    expect(codes(flat)).toEqual(['TIME_DECAY']);
  });

  it('does not apply to a loss', () => {
    expect(codes(review())).not.toContain('TIME_DECAY');
  });
});

describe('the weak groups at entry', () => {
  it('lists the groups that were WEAK or FAIL, in the order of the score', () => {
    const groups = strongGroups({ reward: 'FAIL', trigger: 'WEAK', volatility: 'NA', trend: 'OK' });
    expect(reviewTrade(review({ trade: { ...TRADE, groups } })).weakGroupsAtEntry).toEqual([
      { group: 'trigger', state: 'WEAK' },
      { group: 'reward', state: 'FAIL' },
    ]);
  });

  it('lists none when every group was STRONG, OK or without data', () => {
    expect(reviewTrade(review()).weakGroupsAtEntry).toEqual([]);
    const groups = strongGroups({ structure: 'OK', execution: 'NA' });
    expect(reviewTrade(review({ trade: { ...TRADE, groups } })).weakGroupsAtEntry).toEqual([]);
  });

  it('follows the groups it is given, in any order, and ignores a missing one', () => {
    const groups = [...strongGroups({ sessionMacro: 'FAIL' })].reverse().slice(0, 6);
    const weak = reviewTrade(review({ trade: { ...TRADE, groups } })).weakGroupsAtEntry;
    expect(weak.map((entry) => entry.group)).toEqual(['sessionMacro']);
    expect(QUALITY_GROUPS).toContain(weak[0]?.group);
  });
});

describe('which cause is the primary one', () => {
  const everything = (outcome = LOSS, closedAt = outcome.closedAt) =>
    review({
      trade: { ...TRADE, spreadAtEntry: 3 },
      outcome: { ...outcome, closedAt, mfeR: 0.1 },
      course: courseWith({
        regimeAtClose: 'RANGE',
        structureBreaks: [breakSeen()],
        highImpact: [{ kind: 'EVENT', name: 'US CPI', at: FILL_AT + 5 * MIN }],
        atrRatioMax: 3,
      }),
      afterCandles: candlesAfter(closedAt, 4),
    });

  it('goes by the priority, the first that applies being the primary one', () => {
    expect(CAUSE_PRIORITY).toEqual([
      'STOP_HUNT_REVERSAL',
      'NEWS_SHOCK',
      'NO_FOLLOW_THROUGH',
      'HTF_STRUCTURE_BREAK',
      'REGIME_SHIFT',
      'LIQUIDITY_DROP',
      'SPREAD_COST',
      'TIME_DECAY',
      'NORMAL_LOSS',
    ]);
    expect([...CAUSE_PRIORITY].sort()).toEqual([...CAUSE_CODES].sort());
  });

  it('lists every cause that applies, in that order, with the first one primary', () => {
    const rolled = Date.UTC(2026, 9, 23, 22, 0);
    const final = reviewTrade(
      review({
        trade: { ...TRADE, fillAt: rolled - 15 * MIN, spreadAtEntry: 3 },
        outcome: { ...LOSS, closedAt: rolled, mfeR: 0.1 },
        course: courseWith({
          regimeAtClose: 'RANGE',
          structureBreaks: [breakSeen({ at: rolled - 5 * MIN })],
          highImpact: [{ kind: 'EVENT', name: 'US CPI', at: rolled - 10 * MIN }],
          atrRatioMax: 3,
        }),
        afterCandles: candlesAfter(rolled, 4),
      }),
    );
    expect(final.causes.map((cause) => cause.code)).toEqual([
      'STOP_HUNT_REVERSAL',
      'NEWS_SHOCK',
      'NO_FOLLOW_THROUGH',
      'HTF_STRUCTURE_BREAK',
      'REGIME_SHIFT',
      'LIQUIDITY_DROP',
      'SPREAD_COST',
    ]);
    expect(final.primaryCause).toBe('STOP_HUNT_REVERSAL');
  });

  it('puts the cause that the final review finds ahead of the one the preliminary review chose', () => {
    const preliminary = reviewTrade({ ...everything(), afterCandles: null });
    expect(preliminary.status).toBe('PRELIMINARY');
    expect(preliminary.primaryCause).toBe('NEWS_SHOCK');
    const base = { outcome: { ...LOSS, mfeR: 0.2 } };
    expect(reviewTrade(review(base)).primaryCause).toBe('NO_FOLLOW_THROUGH');
    expect(
      reviewTrade(review({ ...base, afterCandles: candlesAfter(LOSS.closedAt, 7) })).primaryCause,
    ).toBe('STOP_HUNT_REVERSAL');
  });

  it('keeps NO_FOLLOW_THROUGH ahead of the structure break, as in the example of section 14', () => {
    const input = review({
      outcome: { ...LOSS, mfeR: 0.2 },
      course: courseWith({ structureBreaks: [breakSeen()] }),
    });
    expect(codes(input)).toEqual(['NO_FOLLOW_THROUGH', 'HTF_STRUCTURE_BREAK']);
  });

  it('puts TIME_DECAY last, and uses NORMAL_LOSS only when nothing else applies', () => {
    const input = review({
      outcome: { ...TIME_EXIT, mfeR: 0.1 },
      course: courseWith({ regimeAtClose: 'RANGE' }),
    });
    expect(codes(input)).toEqual(['NO_FOLLOW_THROUGH', 'REGIME_SHIFT', 'TIME_DECAY']);
    expect(codes(review())).toEqual(['NORMAL_LOSS']);
  });
});

describe('preliminary and final', () => {
  it('is preliminary without candles and final with them, even with none to see', () => {
    expect(reviewTrade(review({ afterCandles: null })).status).toBe('PRELIMINARY');
    expect(reviewTrade(review({ afterCandles: [] })).status).toBe('FINAL');
    expect(reviewTrade(review({ afterCandles: candlesAfter(LOSS.closedAt, null) })).status).toBe(
      'FINAL',
    );
  });

  it('only differs in the counterfactual and what comes from it', () => {
    const preliminary = reviewTrade(review({ outcome: { ...LOSS, mfeR: 0.2 } }));
    const final = reviewTrade(
      review({ outcome: { ...LOSS, mfeR: 0.2 }, afterCandles: candlesAfter(LOSS.closedAt, null) }),
    );
    expect(final).toEqual({
      ...preliminary,
      status: 'FINAL',
      counterfactual: {
        reachedTp1: false,
        candlesToTp1: null,
        reachedTp2: false,
        candlesToTp2: null,
      },
    });
  });
});

describe('which closed trades are reviewed', () => {
  const needs = (result: Parameters<typeof outcomeOf>[0], isWin: boolean) =>
    needsReview({ result, isWin });

  it('is every loss, every partial win, and a time exit that did not make money', () => {
    expect(needs('LOSS', false)).toBe(true);
    expect(needs('PARTIAL_WIN', true)).toBe(true);
    expect(needs('PARTIAL_WIN', false)).toBe(true);
    expect(needs('TIME_EXIT', false)).toBe(true);
  });

  it('is not a win, a time exit above zero, a cancelled signal or a data gap', () => {
    expect(needs('WIN', true)).toBe(false);
    expect(needs('WIN', false)).toBe(false);
    expect(needs('TIME_EXIT', true)).toBe(false);
    expect(needs('CANCELLED', false)).toBe(false);
    expect(needs('DATA_INVALID', false)).toBe(false);
  });

  it('refuses to review what is not reviewed', () => {
    for (const outcome of [
      outcomeOf('WIN', 20, { exitPrice: 4030.31, realizedRNet: 1.5, isWin: true }),
      outcomeOf('TIME_EXIT', 120, { exitPrice: 4018, realizedRNet: 0.1, isWin: true }),
      outcomeOf('CANCELLED', 0, { countsInStats: false }),
      outcomeOf('DATA_INVALID', 5, { countsInStats: false }),
    ]) {
      expect(() => reviewTrade(review({ outcome })), outcome.result).toThrow(RangeError);
    }
  });
});

describe('what a review refuses', () => {
  it('an outcome without its net R or its exit price', () => {
    expect(() => reviewTrade(review({ outcome: { ...LOSS, realizedRNet: null } }))).toThrow(
      RangeError,
    );
    expect(() => reviewTrade(review({ outcome: { ...LOSS, exitPrice: null } }))).toThrow(
      RangeError,
    );
  });

  it('numbers that are not numbers, a risk or an ATR of zero, a close before the fill', () => {
    const bad = (trade: Partial<ReviewedTrade>) =>
      reviewTrade(review({ trade: { ...TRADE, ...trade } }));
    expect(() => bad({ fill: Number.NaN })).toThrow(RangeError);
    expect(() => bad({ fillAt: Number.NaN })).toThrow(RangeError);
    expect(() => bad({ tp1: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => bad({ riskDistance: 0 })).toThrow(RangeError);
    expect(() => bad({ riskDistance: -1 })).toThrow(RangeError);
    expect(() => bad({ atr5: 0 })).toThrow(RangeError);
    expect(() => bad({ atr5: Number.NaN })).toThrow(RangeError);
    expect(() => bad({ fillAt: LOSS.closedAt + 1 })).toThrow(RangeError);
    expect(() => reviewTrade(review({ outcome: { ...LOSS, closedAt: Number.NaN } }))).toThrow(
      RangeError,
    );
    expect(() => bad({ fillAt: LOSS.closedAt })).not.toThrow();
  });
});
