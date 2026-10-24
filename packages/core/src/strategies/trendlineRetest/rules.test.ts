import { describe, expect, it } from 'vitest';

import type { StructureCandle } from '../../structure/types';
import { bar, makeLine, when } from '../../trendlines/test-data';
import {
  allTrendlineChecksPass,
  brokenBefore,
  chooseBreak,
  hourAligned,
  hourTrendOk,
  judgeTrendline,
  lineRetestOf,
  lineRetestStop,
  sameLine,
  touchedLine,
} from './rules';
import {
  TRENDLINE_CHECKS,
  TRENDLINE_RETEST_DEFAULTS,
  type BreakCandidate,
  type HourTrend,
  type TrendlineCheck,
  type TrendlineInputs,
  type TrendlineRetestParams,
} from './types';

const P = TRENDLINE_RETEST_DEFAULTS;

/** A falling resistance line: 120 at candle 0, one lower with every candle, so 110 at candle 10. */
const LINE = makeLine('RESISTANCE', [0, 100], [20, 120]);
const ATR = 2;

describe('the 1h trend must not be strongly against the break', () => {
  const trend = (adx: number, plusDI: number, minusDI: number): HourTrend => ({
    adx,
    plusDI,
    minusDI,
  });

  it('passes when ADX(1h) is below 30, whichever way the trend points', () => {
    expect(hourTrendOk(trend(29.99, 10, 40), P)).toBe(true);
    expect(hourTrendOk(trend(30, 10, 40), P)).toBe(false);
    expect(hourTrendOk(trend(10, 40, 10), P)).toBe(true);
  });

  it('passes when the trend points the way of the break, however strong', () => {
    expect(hourTrendOk(trend(60, 30, 20), P)).toBe(true);
    expect(hourTrendOk(trend(60, 20, 20), P)).toBe(true);
    expect(hourTrendOk(trend(60, 19.99, 20), P)).toBe(false);
  });

  it('fails when the trend is against and strong', () => {
    expect(hourTrendOk(trend(45, 12, 33), P)).toBe(false);
  });

  it('the limit comes from the params', () => {
    expect(hourTrendOk(trend(35, 10, 40), { maxAdx1hAgainst: 35 })).toBe(false);
    expect(hourTrendOk(trend(35, 10, 40), { maxAdx1hAgainst: 35.01 })).toBe(true);
  });

  it('fails while the indicator is still warming up', () => {
    expect(hourTrendOk(null, P)).toBe(false);
  });

  it('points the way of the break when +DI is at or above -DI (a BUY)', () => {
    expect(hourAligned(trend(60, 20, 20))).toBe(true);
    expect(hourAligned(trend(60, 20.01, 20))).toBe(true);
    expect(hourAligned(trend(60, 19.99, 20))).toBe(false);
  });
});

describe('a candle that comes back to the line', () => {
  // the line is at 110 on candle 10, and the zone is 0.3 x ATR(2) = 0.6 above it
  const touched = (
    low: number,
    atr: number | null = ATR,
    params: Pick<TrendlineRetestParams, 'retestMaxDistanceAtr'> = P,
  ) => touchedLine(LINE, bar(10, 112, 113, low, 112.5), atr, params);

  it('has its low at most 0.3 x ATR above the line, or beyond it', () => {
    expect(touched(110.6)).toBe(true);
    expect(touched(110.61)).toBe(false);
    expect(touched(110)).toBe(true);
    expect(touched(108)).toBe(true);
  });

  it('reads the line at the opening of the candle, and the zone from the params', () => {
    expect(touchedLine(LINE, bar(11, 112, 113, 109.6, 112.5), ATR, P)).toBe(true);
    expect(touchedLine(LINE, bar(11, 112, 113, 109.61, 112.5), ATR, P)).toBe(false);
    expect(touched(110.61, ATR, { retestMaxDistanceAtr: 0.31 })).toBe(true);
    expect(touched(110.4, ATR, { retestMaxDistanceAtr: 0.1 })).toBe(false);
  });

  it('cannot be judged without an ATR', () => {
    expect(touched(100, null)).toBe(false);
  });
});

describe('the retest candle against a break', () => {
  const candidate = { line: LINE, returned: true };
  const of = (candle: StructureCandle, rsi: number | null = 60, atr: number | null = ATR) =>
    lineRetestOf(candidate, candle, atr, rsi, P);
  // line 110 on candle 10; range 10 from 111 to 121
  const wickCandle = (wick: number) => bar(10, 111 + wick, 121, 111, 120);

  it('closes at least 0.3 x ATR above the line', () => {
    expect(of(bar(10, 111, 112, 110.5, 110.6)).closedAway).toBe(true);
    expect(of(bar(10, 111, 112, 110.5, 110.59)).closedAway).toBe(false);
    expect(of(bar(10, 111, 112, 110.5, 109)).closedAway).toBe(false);
    expect(of(bar(10, 111, 112, 110.5, 110.8), 60, null).closedAway).toBe(false);
  });

  it('has a lower wick of at least 30% of its range', () => {
    expect(of(wickCandle(3)).wick).toBe(true);
    expect(of(wickCandle(3)).wickRatio).toBeCloseTo(0.3, 12);
    expect(of(wickCandle(2.9)).wick).toBe(false);
    expect(of(wickCandle(2.9)).wickRatio).toBeCloseTo(0.29, 12);
    expect(of(bar(10, 119, 121, 111, 120)).wickRatio).toBeCloseTo(0.8, 12);
  });

  it('the wick is measured under the body, whichever way the candle goes', () => {
    expect(of(bar(10, 120, 121, 111, 114)).wickRatio).toBeCloseTo(0.3, 12);
  });

  it('a candle with no range has no wick', () => {
    const flat = of(bar(10, 115, 115, 115, 115));
    expect(flat.wick).toBe(false);
    expect(flat.wickRatio).toBe(0);
  });

  it('has RSI strictly above 45', () => {
    const candle = bar(10, 114, 121, 111, 120);
    expect(of(candle, 45).rsiAbove).toBe(false);
    expect(of(candle, 45.0001).rsiAbove).toBe(true);
    expect(of(candle, 20).rsiAbove).toBe(false);
    expect(of(candle, null).rsiAbove).toBe(false);
  });

  it('reports the price of the line at the candle, and whether price had returned', () => {
    expect(of(bar(10, 111, 112, 110.5, 111)).lineValue).toBe(110);
    expect(of(bar(15, 111, 112, 110.5, 111)).lineValue).toBe(105);
    expect(
      lineRetestOf({ line: LINE, returned: false }, bar(10, 114, 121, 111, 120), ATR, 60, P),
    ).toMatchObject({
      returned: false,
    });
  });

  it('takes the distance, the wick and the RSI from the params', () => {
    const candle = bar(10, 112, 121, 111, 112);
    // closes 2 above the line: 1 ATR; wick 1 of 10
    const test = (params: Partial<typeof P>) =>
      lineRetestOf(candidate, candle, ATR, 50, { ...P, ...params });
    expect(test({ retestMaxDistanceAtr: 1 }).closedAway).toBe(true);
    expect(test({ retestMaxDistanceAtr: 1.01 }).closedAway).toBe(false);
    expect(test({ retestMinWickFraction: 0.1 }).wick).toBe(true);
    expect(test({ retestMinWickFraction: 0.11 }).wick).toBe(false);
    expect(test({ retestMinRsi: 49.9 }).rsiAbove).toBe(true);
    expect(test({ retestMinRsi: 50 }).rsiAbove).toBe(false);
  });
});

describe('which break the newest candle is judged against', () => {
  const second = makeLine('RESISTANCE', [0, 90], [20, 110]);
  const waiting = (change: Partial<BreakCandidate>): BreakCandidate => ({
    line: LINE,
    breakOpenTime: when(0),
    candlesSince: 3,
    lowest: 110.5,
    returned: true,
    beyondAtr: 0.5,
    bodyRatio: 0.9,
    ...change,
  });
  // above the line (110) and above the second line (120 at candle 10), with a long lower wick
  const retest = bar(10, 120, 122, 111, 121);
  const choose = (candidates: BreakCandidate[], candle = retest) =>
    chooseBreak(candidates, candle, ATR, 60, P);

  it('is none when nothing is waiting', () => {
    expect(choose([])).toBeNull();
  });

  it('is the only one that is waiting', () => {
    const only = waiting({ candlesSince: 5 });
    expect(choose([only])).toBe(only);
  });

  it('is the newest of those whose retest this candle completes, in whatever order they come', () => {
    const older = waiting({ candlesSince: 6, line: second });
    const newer = waiting({ candlesSince: 2 });
    expect(choose([older, newer])).toBe(newer);
    expect(choose([newer, older])).toBe(newer);
  });

  it('skips a newer break whose retest this candle does not complete', () => {
    const older = waiting({ candlesSince: 6, line: second });
    const newer = waiting({ candlesSince: 2, returned: false });
    expect(choose([newer, older])).toBe(older);
  });

  it('is the newest when none is completed, so that the missing rules can be shown', () => {
    const older = waiting({ candlesSince: 6, returned: false });
    const newer = waiting({ candlesSince: 2, returned: false });
    expect(choose([older, newer])).toBe(newer);
    expect(choose([newer, older])).toBe(newer);
  });

  it('a retest needs the wick and the RSI too: without them none is completed, even with the return and the close', () => {
    const older = waiting({ candlesSince: 6, line: second });
    const newer = waiting({ candlesSince: 2, returned: false });
    // closes 2 above the second line with no lower wick at all
    const noWick = bar(10, 121.9, 122, 121.9, 122);
    expect(choose([newer, older], noWick)).toBe(newer);
    expect(choose([newer, older])).toBe(older);
    expect(chooseBreak([newer, older], retest, ATR, 45, P)).toBe(newer);
    expect(chooseBreak([newer, older], retest, ATR, 45.0001, P)).toBe(older);
  });

  it('a retest needs the close away from the line: a close inside the zone completes none', () => {
    const older = waiting({ candlesSince: 6 });
    const newer = waiting({ candlesSince: 2, returned: false });
    expect(choose([newer, older], bar(10, 110.4, 111, 109, 110.5))).toBe(newer);
  });

  it('judges each break against its own line', () => {
    // this candle closes 0.65 above the first line (110) and far below the second (120)
    const nearFirst = bar(10, 110.6, 110.9, 110.3, 110.65);
    const forFirst = waiting({ candlesSince: 4 });
    const forSecond = waiting({ candlesSince: 3, line: second });
    expect(chooseBreak([forFirst, forSecond], nearFirst, ATR, 60, P)).toBe(forFirst);
  });
});

describe('each rule on its own', () => {
  const candidate: BreakCandidate = {
    line: LINE,
    breakOpenTime: when(0),
    candlesSince: 4,
    lowest: 110.1,
    returned: true,
    beyondAtr: 0.5,
    bodyRatio: 0.9,
  };
  // line 110: closes 7 above it, lower wick 5 of 10, and RSI 60
  const inputs: TrendlineInputs = {
    trend: { adx: 20, plusDI: 20, minusDI: 20 },
    candidate,
    candle: bar(10, 116, 121, 111, 117),
    atr: ATR,
    rsi: 60,
  };

  it('all hold in the base inputs', () => {
    const checks = judgeTrendline(inputs, P);
    expect(TRENDLINE_CHECKS.filter((check) => !checks[check])).toEqual([]);
    expect(allTrendlineChecksPass(checks)).toBe(true);
  });

  const cases: [TrendlineCheck, Partial<TrendlineInputs>][] = [
    ['trend1h', { trend: null }],
    ['lineBroken', { candidate: null }],
    ['returned', { candidate: { ...candidate, returned: false } }],
    ['closedAway', { candle: bar(10, 110.9, 111, 109, 110.4) }],
    ['rejectionWick', { candle: bar(10, 111, 121, 110.5, 112) }],
    ['rsiAbove', { rsi: 45 }],
  ];

  it.each(cases)('%s fails alone, and only that rule', (check, change) => {
    const checks = judgeTrendline({ ...inputs, ...change }, P);
    expect(TRENDLINE_CHECKS.filter((rule) => !checks[rule])).toEqual(
      check === 'lineBroken'
        ? ['lineBroken', 'returned', 'closedAway', 'rejectionWick', 'rsiAbove']
        : [check],
    );
    expect(allTrendlineChecksPass(checks)).toBe(false);
  });

  it('with no ATR or RSI yet, the rules that need them fail', () => {
    expect(judgeTrendline({ ...inputs, atr: null }, P)).toMatchObject({
      closedAway: false,
      lineBroken: true,
    });
    expect(judgeTrendline({ ...inputs, rsi: null }, P).rsiAbove).toBe(false);
  });
});

describe('the stop', () => {
  it('is 0.25 x ATR beyond the retest low when the low did not reach the line', () => {
    const stop = lineRetestStop(110.4, 110, 2, P);
    expect(stop?.price).toBeCloseTo(109.9, 12);
    expect(stop?.fromLine).toBe(false);
  });

  it('is 0.25 x ATR beyond the line when the low went through it: that is the closer one', () => {
    const stop = lineRetestStop(109.2, 110, 2, P);
    expect(stop?.price).toBeCloseTo(109.5, 12);
    expect(stop?.fromLine).toBe(true);
  });

  it('is the same from either when the low is on the line', () => {
    const stop = lineRetestStop(110, 110, 2, P);
    expect(stop?.price).toBeCloseTo(109.5, 12);
    expect(stop?.fromLine).toBe(false);
  });

  it('takes the buffer from the params, and is unknown without an ATR', () => {
    expect(lineRetestStop(110.4, 110, 2, { stopBufferAtr: 1 })?.price).toBeCloseTo(108.4, 12);
    expect(lineRetestStop(110.4, 110, null, P)).toBeNull();
  });
});

describe('a line and its twin', () => {
  // the tolerance is 0.15 x ATR(2) = 0.3
  const shifted = (by: number) => ({ ...LINE, a: { ...LINE.a, price: LINE.a.price + by } });

  it('are within 0.15 x ATR of each other', () => {
    expect(sameLine(LINE, shifted(0), when(10), ATR, 0.15)).toBe(true);
    expect(sameLine(LINE, shifted(0.3), when(10), ATR, 0.15)).toBe(true);
    expect(sameLine(LINE, shifted(0.31), when(10), ATR, 0.15)).toBe(false);
  });

  it('are compared either way round', () => {
    expect(sameLine(LINE, shifted(-0.3), when(10), ATR, 0.15)).toBe(true);
    expect(sameLine(LINE, shifted(-0.31), when(10), ATR, 0.15)).toBe(false);
    expect(sameLine(shifted(0.31), LINE, when(10), ATR, 0.15)).toBe(false);
  });

  it('are compared where the candle is: lines that cross are twins only there', () => {
    const steeper = { ...LINE, slope: LINE.slope - 0.1 };
    // the same at the first point, 0.1 x candles apart later
    expect(sameLine(LINE, steeper, when(0), ATR, 0.15)).toBe(true);
    expect(sameLine(LINE, steeper, when(3), ATR, 0.15)).toBe(true);
    expect(sameLine(LINE, steeper, when(4), ATR, 0.15)).toBe(false);
  });

  it('use the tolerance and the ATR they are given', () => {
    expect(sameLine(LINE, shifted(0.5), when(10), ATR, 0.25)).toBe(true);
    expect(sameLine(LINE, shifted(0.5), when(10), 1.5, 0.25)).toBe(false);
  });

  it('are looked for among all the lines that were broken, wherever they are in the list', () => {
    const near = shifted(0.2);
    const far = shifted(5);
    const further = shifted(-4);
    expect(brokenBefore([], LINE, when(10), ATR, 0.15)).toBe(false);
    expect(brokenBefore([far, further], LINE, when(10), ATR, 0.15)).toBe(false);
    expect(brokenBefore([far, near], LINE, when(10), ATR, 0.15)).toBe(true);
    expect(brokenBefore([near, far], LINE, when(10), ATR, 0.15)).toBe(true);
    expect(brokenBefore([far, further, near], LINE, when(10), ATR, 0.15)).toBe(true);
  });
});
