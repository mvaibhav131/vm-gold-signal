import { describe, expect, it } from 'vitest';

import {
  ADX_TREND,
  judgeHourTrend,
  judgeQuarterTrend,
  stopPlan,
  triggerBody,
  votesFor,
  type VoteInput,
} from './rules';
import { CONFLUENCE_DEFAULTS, CONFLUENCE_VOTES } from './types';

/** A market in which all nine questions answer yes for a BUY. */
const BUY_INPUT: VoteInput = {
  trend1h: 'UP',
  trend15m: 'UP',
  close: 4010,
  emaFast: 4008,
  emaMid: 4004,
  rsi: 60,
  macdHistogram: 0.4,
  macdChange: 0.1,
  adx: 28,
  plusDI: 30,
  minusDI: 12,
  dayMean: 4000,
  priorHigh: 4009,
  priorLow: 3995,
  atr: 2,
};

/** The same market with every price negated: what a SELL sees. */
function mirror(input: VoteInput): VoteInput {
  return {
    trend1h: input.trend1h === 'UP' ? 'DOWN' : input.trend1h === 'DOWN' ? 'UP' : null,
    trend15m: input.trend15m === 'UP' ? 'DOWN' : input.trend15m === 'DOWN' ? 'UP' : null,
    close: -input.close,
    emaFast: -input.emaFast,
    emaMid: -input.emaMid,
    rsi: 100 - input.rsi,
    macdHistogram: -input.macdHistogram,
    macdChange: input.macdChange === null ? null : -input.macdChange,
    adx: input.adx,
    plusDI: input.minusDI,
    minusDI: input.plusDI,
    dayMean: -input.dayMean,
    priorHigh: -input.priorLow,
    priorLow: -input.priorHigh,
    atr: input.atr,
  };
}

describe('the trend of a chart', () => {
  it('is UP with the fast average over the middle one and the price over the slow one, DOWN for the mirror, and none when they disagree', () => {
    expect(judgeHourTrend(4010, 4008, 4004, 3990)).toBe('UP');
    expect(judgeHourTrend(3990, 4000, 4004, 4010)).toBe('DOWN');
    expect(judgeHourTrend(3980, 4008, 4004, 3990)).toBeNull();
    expect(judgeHourTrend(4010, 4000, 4004, 3990)).toBeNull();
    expect(judgeHourTrend(4010, 4004, 4004, 3990)).toBeNull();
  });

  it('reads only the two averages on the 15m chart', () => {
    expect(judgeQuarterTrend(4008, 4004)).toBe('UP');
    expect(judgeQuarterTrend(4000, 4004)).toBe('DOWN');
    expect(judgeQuarterTrend(4004, 4004)).toBeNull();
  });
});

describe('the votes', () => {
  it('count all nine for a market that agrees with a BUY in everything, in the order of the list', () => {
    expect(votesFor('BUY', BUY_INPUT)).toEqual([...CONFLUENCE_VOTES]);
    expect(votesFor('SELL', BUY_INPUT)).toEqual([]);
  });

  it.each([
    ['TREND_1H', { trend1h: 'DOWN' as const }],
    ['TREND_15M', { trend15m: null }],
    ['EMA_STACK_5M', { emaMid: 4009 }],
    ['RSI', { rsi: 48 }],
    ['RSI', { rsi: 75 }],
    ['MACD', { macdHistogram: -0.1 }],
    ['MACD', { macdChange: -0.2 }],
    ['MACD', { macdChange: null }],
    ['ADX', { adx: ADX_TREND - 1 }],
    ['ADX', { plusDI: 10 }],
    ['DAY_MEAN', { dayMean: 4012 }],
    ['BREAKOUT', { priorHigh: 4010 }],
    ['NOT_STRETCHED', { emaFast: 4006.9 }],
    ['NOT_STRETCHED', { emaFast: 4011 }],
  ] as const)('lose the %s vote when it is not so (%j)', (vote, change) => {
    expect(votesFor('BUY', { ...BUY_INPUT, ...change })).not.toContain(vote);
    // and only that one
    const lost = CONFLUENCE_VOTES.filter(
      (name) => !votesFor('BUY', { ...BUY_INPUT, ...change }).includes(name),
    );
    expect(lost).toEqual([vote]);
  });

  it('give a SELL exactly the votes that a BUY gets in the mirrored market', () => {
    for (const change of [
      {},
      { rsi: 48 },
      { macdChange: -0.2 },
      { priorHigh: 4010 },
      { trend1h: 'DOWN' as const },
      { dayMean: 4012, adx: 10 },
    ]) {
      const input = { ...BUY_INPUT, ...change };
      expect(votesFor('SELL', mirror(input))).toEqual(votesFor('BUY', input));
      expect(votesFor('BUY', mirror(input))).toEqual(votesFor('SELL', input));
    }
  });
});

describe('the trigger candle', () => {
  it('must push the way of the trade with a body of at least the share of ATR', () => {
    expect(triggerBody('BUY', 4000, 4000.8, 2, 0.4)).toBe(true);
    expect(triggerBody('BUY', 4000, 4000.79, 2, 0.4)).toBe(false);
    expect(triggerBody('BUY', 4000, 3999, 2, 0.4)).toBe(false);
    expect(triggerBody('SELL', 4000, 3999.2, 2, 0.4)).toBe(true);
    expect(triggerBody('SELL', 4000, 4001, 2, 0.4)).toBe(false);
  });
});

describe('the stop', () => {
  const P = CONFLUENCE_DEFAULTS;

  it('goes beyond the swing by the buffer, and is the distance from the close to that level', () => {
    // swing 4001.5, buffer 0.5 x 2 = 1, so the stop is 4000.5 and the distance 9.5 from 4010... too far for 4.2 ATR (8.4)
    expect(stopPlan('BUY', 4010, 2, 4001.5, P)).toBeNull();
    // swing 4004: stop 4003, distance 7 (3.5 ATR)
    expect(stopPlan('BUY', 4010, 2, 4004, P)).toEqual({
      stopLoss: 4003,
      distance: 7,
      swingLevel: 4004,
    });
    expect(stopPlan('SELL', 4010, 2, 4016, P)).toEqual({
      stopLoss: 4017,
      distance: 7,
      swingLevel: 4016,
    });
  });

  it('is never closer than the minimum: a swing that is near gives the minimum, not a stop at the level', () => {
    // swing 4009: the structure puts the stop 2 away (4008), the minimum is 3 ATR = 6
    expect(stopPlan('BUY', 4010, 2, 4009, P)).toMatchObject({ stopLoss: 4004, distance: 6 });
  });

  it('is skipped when the structure is further than the largest stop, and not pulled in to a place the structure would take out', () => {
    expect(stopPlan('BUY', 4010, 2, 4000, P)).toBeNull();
    expect(stopPlan('BUY', 4010, 2, 4002.7, P)?.distance).toBeCloseTo(8.3, 9);
    expect(stopPlan('BUY', 4010, 2, 4002.5, P)).toBeNull();
  });

  it('is skipped when it is wider than the dollar limit, however many ATR it is', () => {
    // ATR 4: a stop of 14 USD (3.5 ATR) fits
    expect(stopPlan('BUY', 4010, 4, 4010 - 14 + 2, P)?.distance).toBeCloseTo(14, 9);
    // ATR 5: the minimum of 3 ATR is already 15 USD, which fits; at ATR 5.4 it is 16.2 USD, over the limit of 16
    expect(stopPlan('BUY', 4010, 5, 4009, P)?.distance).toBe(15);
    expect(stopPlan('BUY', 4010, 5.4, 4009, P)).toBeNull();
  });

  it('is the exact mirror for a SELL', () => {
    for (const swing of [4004, 4009, 4002.7, 4002.5]) {
      const buy = stopPlan('BUY', 4010, 2, swing, P);
      const sell = stopPlan('SELL', -4010, 2, -swing, P);
      // the negated market: the stop of a SELL is the negated stop of the BUY
      expect(sell === null).toBe(buy === null);
      if (buy !== null && sell !== null) {
        expect(sell.distance).toBeCloseTo(buy.distance, 9);
      }
    }
  });
});
