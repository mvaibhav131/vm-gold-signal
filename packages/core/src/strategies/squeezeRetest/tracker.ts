import type { Side } from '../../domain';
import { Adx } from '../../indicators/directional';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { Atr, Donchian, Squeeze } from '../../indicators/volatility';
import { assertCandle, assertInOrder, type StructureCandle } from '../../structure/types';
import { mirrorCandle } from '../mirror';
import { keyTime } from '../types';
import {
  allSqueezeChecksPass,
  breakoutOf,
  chooseBreakout,
  judgeSqueeze,
  retestOf,
  retestStop,
  type Breakout,
} from './rules';
import {
  SQUEEZE_RETEST_DEFAULTS,
  type BreakoutCandidate,
  type SqueezeContext,
  type SqueezeEvaluation,
  type SqueezeInputs,
  type SqueezeRetestParams,
  type SqueezeSideEvaluation,
} from './types';

function assertParams(params: SqueezeRetestParams): void {
  assertPeriod(params.atrPeriod, 'atrPeriod');
  assertPeriod(params.adxPeriod, 'adxPeriod');
  assertPeriod(params.squeezeMinCandles15m, 'squeezeMinCandles15m');
  assertPeriod(params.releaseWithinCandles15m, 'releaseWithinCandles15m');
  assertPeriod(params.donchianPeriod, 'donchianPeriod');
  assertPeriod(params.retestWithinCandles, 'retestWithinCandles');
  for (const name of [
    'breakoutMinAtr',
    'retestMaxDistanceAtr',
    'rejectionWickRatio',
    'stopBufferAtr',
  ] as const) {
    assertFinite(params[name], name);
    if (params[name] < 0) throw new RangeError(`${name} cannot be negative`);
  }
  if (params.rejectionWickRatio > 1) throw new RangeError('rejectionWickRatio cannot exceed 1');
}

interface Waiting extends Breakout {
  /** Position of the breakout candle in the 5m series fed so far. */
  readonly index: number;
  readonly openTime: number;
  /** The lowest low since the breakout candle: infinite until the next candle has come. */
  lowest: number;
}

/**
 * One direction of the strategy. It is written for a BUY only (a breakout above and a retest from
 * above). The SELL side runs the same code on mirrored candles, so SELL is the exact mirror of BUY
 * by construction, and its numbers are turned back into real prices when a setup is made. The
 * squeeze and ADX do not care about direction, so mirroring changes nothing for them.
 */
class SqueezeSide {
  private readonly sign: 1 | -1;
  private readonly atr: Atr;
  private readonly adx: Adx;
  private readonly donchian: Donchian;
  private readonly squeeze = new Squeeze();
  private squeezeRun = 0;
  private releasedRun: number | null = null;
  private context: SqueezeContext = { on: null, releasedRun: null, barsSinceRelease: null };
  private seenFive = 0;
  private previousAdx: number | null = null;
  private waiting: Waiting[] = [];
  private tested: BreakoutCandidate[] = [];
  private newest: StructureCandle | null = null;
  private newestAtr: number | null = null;

  constructor(
    private readonly side: Side,
    private readonly params: SqueezeRetestParams,
  ) {
    this.sign = side === 'BUY' ? 1 : -1;
    this.atr = new Atr(params.atrPeriod);
    this.adx = new Adx(params.adxPeriod);
    this.donchian = new Donchian(params.donchianPeriod);
  }

  updateQuarter(real: StructureCandle): void {
    const candle = this.sign === 1 ? real : mirrorCandle(real);
    const before = this.squeezeRun;
    const value = this.squeeze.update(candle);
    if (value === null) return;
    if (value.released) this.releasedRun = before;
    this.squeezeRun = value.duration;
    this.context = {
      on: value.on,
      releasedRun: this.releasedRun,
      barsSinceRelease: value.barsSinceRelease,
    };
  }

  updateFive(real: StructureCandle): void {
    const candle = this.sign === 1 ? real : mirrorCandle(real);
    const atr = this.atr.update(candle);
    const channel = this.donchian.update(candle);
    const adx = this.adx.update(candle)?.adx ?? null;
    const index = this.seenFive;
    this.seenFive += 1;

    // The breakouts that were waiting before this candle are the ones it can retest.
    for (const waiting of this.waiting) waiting.lowest = Math.min(waiting.lowest, candle.l);
    this.tested = this.waiting.map((waiting) => ({
      level: waiting.level,
      openTime: waiting.openTime,
      candlesSince: index - waiting.index,
      lowest: waiting.lowest,
      closeAtr: waiting.closeAtr,
      displacementAtr: waiting.displacementAtr,
      adx: waiting.adx,
      adxBefore: waiting.adxBefore,
    }));
    // A breakout whose level has not held on a close, or whose window is over, is finished.
    this.waiting = this.waiting.filter(
      (waiting) =>
        candle.c >= waiting.level && index - waiting.index < this.params.retestWithinCandles,
    );

    // This candle can be a breakout itself, but it is never the entry: it is tested from the next one.
    const found = breakoutOf(
      { candle, atr, priorUpper: channel?.priorUpper ?? null, adx, adxBefore: this.previousAdx },
      this.params,
    );
    if (found !== null) {
      this.waiting.push({
        ...found,
        index,
        openTime: candle.openTime,
        lowest: Number.POSITIVE_INFINITY,
      });
    }
    this.previousAdx = adx;
    this.newest = candle;
    this.newestAtr = atr;
  }

  evaluate(): SqueezeSideEvaluation | null {
    const newest = this.newest;
    if (newest === null) return null;
    const atr = this.newestAtr;
    const inputs: SqueezeInputs = {
      context: this.context,
      breakout: chooseBreakout(this.tested, newest, atr, this.params),
      candle: newest,
      atr,
    };
    const checks = judgeSqueeze(inputs, this.params);
    const { breakout } = inputs;
    const stop = retestStop(breakout?.lowest ?? null, atr, this.params);
    const { releasedRun, barsSinceRelease } = this.context;
    if (
      !allSqueezeChecksPass(checks) ||
      breakout === null ||
      stop === null ||
      atr === null ||
      releasedRun === null ||
      barsSinceRelease === null
    ) {
      return { checks, setup: null };
    }

    const test = retestOf(breakout, newest, atr, this.params);
    const price = (value: number) => this.sign * value;
    return {
      checks,
      setup: {
        strategyKey: 'squeeze_retest',
        side: this.side,
        setupKey: `squeeze_retest:5m:brk-${keyTime(breakout.openTime)}`,
        at: newest.openTime,
        close: price(newest.c),
        stopLoss: price(stop),
        facts: {
          level: price(breakout.level),
          breakoutOpenTime: breakout.openTime,
          candlesSinceBreakout: breakout.candlesSince,
          breakoutCloseAtr: breakout.closeAtr,
          breakoutDisplacementAtr: breakout.displacementAtr,
          adx: breakout.adx,
          adxBefore: breakout.adxBefore,
          retestExtreme: price(breakout.lowest),
          retestDistanceAtr: (breakout.lowest - breakout.level) / atr,
          wickRatio: test.wickRatio,
          squeezeCandles15m: releasedRun,
          candlesSinceRelease15m: barsSinceRelease,
          atr,
        },
      },
    };
  }
}

export type SqueezeTimeframe = '5m' | '15m';

/**
 * Strategy C, Squeeze Breakout and Retest (docs/02 section 7.C). Feed it every closed 5m candle
 * and every closed 15m candle, each timeframe in time order; `evaluate()` then answers for the
 * newest 5m candle: the rules of each side and, if all hold, the setup with its stop. The regime
 * gate (SQUEEZE or BREAKOUT) is the engine's, not the strategy's.
 *
 * When a 5m and a 15m candle close at the same moment, push both before calling `evaluate()`: the
 * answer then does not depend on the order. Everything is streaming and only looks back, so the
 * answer for a candle never changes when later candles arrive.
 */
export class SqueezeRetestStrategy {
  private readonly sides: Readonly<Record<Side, SqueezeSide>>;
  private readonly lastOpenTime: Record<SqueezeTimeframe, number | null> = {
    '5m': null,
    '15m': null,
  };
  private readonly counts: Record<SqueezeTimeframe, number> = { '5m': 0, '15m': 0 };
  private newest: StructureCandle | null = null;

  constructor(private readonly params: SqueezeRetestParams = SQUEEZE_RETEST_DEFAULTS) {
    assertParams(params);
    this.sides = { BUY: new SqueezeSide('BUY', params), SELL: new SqueezeSide('SELL', params) };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<SqueezeTimeframe, number>> {
    return { ...this.counts };
  }

  updateQuarter(candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime['15m'], candle);
    this.lastOpenTime['15m'] = candle.openTime;
    this.counts['15m'] += 1;
    this.sides.BUY.updateQuarter(candle);
    this.sides.SELL.updateQuarter(candle);
  }

  updateFive(candle: StructureCandle): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime['5m'], candle);
    this.lastOpenTime['5m'] = candle.openTime;
    this.counts['5m'] += 1;
    this.newest = candle;
    this.sides.BUY.updateFive(candle);
    this.sides.SELL.updateFive(candle);
  }

  /** The rules and the setup as of the newest 5m candle; null before the first one. */
  evaluate(): SqueezeEvaluation | null {
    const newest = this.newest;
    const buy = this.sides.BUY.evaluate();
    const sell = this.sides.SELL.evaluate();
    if (newest === null || buy === null || sell === null) return null;
    return {
      openTime: newest.openTime,
      close: newest.c,
      BUY: buy,
      SELL: sell,
      setup: buy.setup ?? sell.setup,
    };
  }
}
