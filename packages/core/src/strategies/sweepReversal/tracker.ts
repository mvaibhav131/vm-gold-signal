import { TIMEFRAME_MS, type Regime, type Side } from '../../domain';
import { DivergenceTracker } from '../../divergence/tracker';
import type { Divergence } from '../../divergence/types';
import { assertFinite, assertPeriod } from '../../indicators/types';
import { StructureTracker } from '../../structure/breaks';
import { MarketStructure } from '../../structure/marketStructure';
import type { LiquidityLevel, SweepReclaim } from '../../structure/sweeps';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type StructureCandle,
} from '../../structure/types';
import { mirrorCandle, mirrorLevel } from '../mirror';
import { keyTime } from '../types';
import { allSweepChecksPass, choch15mHolds, chooseSweep, judgeSweep, sweepStop } from './rules';
import {
  SWEEP_REVERSAL_DEFAULTS,
  type SweepCandidate,
  type SweepEvaluation,
  type SweepInputs,
  type SweepReversalParams,
  type SweepSideEvaluation,
} from './types';

function assertParams(params: SweepReversalParams): void {
  assertPeriod(params.atrPeriod, 'atrPeriod');
  assertPeriod(params.triggerWithinCandles, 'triggerWithinCandles');
  assertFinite(params.stopBufferAtr, 'stopBufferAtr');
  if (params.stopBufferAtr < 0) throw new RangeError('stopBufferAtr cannot be negative');
}

function assertLevels(levels: readonly LiquidityLevel[]): void {
  for (const level of levels) {
    if (level.id === '') throw new RangeError('a liquidity level needs an id');
    assertFinite(level.price, 'level price');
  }
}

/** How many divergences are remembered: a sweep is only a few candles old. */
const KEPT_DIVERGENCES = 8;

interface Reclaim {
  readonly sweep: SweepReclaim;
  /** The lowest low from the start of the sweep to the newest candle. */
  lowest: number;
}

/**
 * One direction of the strategy. It is written for a BUY only (a bullish sweep of a liquidity
 * low). The SELL side runs the same code on mirrored candles and levels, so SELL is the exact
 * mirror of BUY by construction, and its numbers are turned back into real prices when a setup is
 * made.
 */
class SweepSide {
  private readonly sign: 1 | -1;
  private readonly five: MarketStructure;
  private readonly quarter = new StructureTracker();
  private readonly divergence = new DivergenceTracker('5m');
  private divergences: Divergence[] = [];
  private reclaims: Reclaim[] = [];
  private newest: StructureCandle | null = null;
  private newestIndex = -1;
  private chochLevel: number | null = null;
  private displacementAtr: number | null = null;

  constructor(
    private readonly side: Side,
    private readonly params: SweepReversalParams,
  ) {
    this.sign = side === 'BUY' ? 1 : -1;
    this.five = new MarketStructure(STRUCTURE_DEFAULTS, params.atrPeriod);
  }

  updateQuarter(real: StructureCandle): void {
    this.quarter.update(this.sign === 1 ? real : mirrorCandle(real));
  }

  updateFive(real: StructureCandle, levels: readonly LiquidityLevel[]): void {
    const candle = this.sign === 1 ? real : mirrorCandle(real);
    // Only the liquidity below the price matters to a BUY: highs in the real market for a SELL.
    const own =
      this.sign === 1
        ? levels.filter((level) => level.side === 'LOW')
        : levels.filter((level) => level.side === 'HIGH').map(mirrorLevel);
    const step = this.five.update(candle, own);
    for (const found of this.divergence.update(candle, this.five)) {
      if (found.source === 'RSI' && found.kind === 'REGULAR' && found.direction === 'UP') {
        this.divergences = [...this.divergences, found].slice(-KEPT_DIVERGENCES);
      }
    }

    for (const reclaim of this.reclaims) reclaim.lowest = Math.min(reclaim.lowest, candle.l);
    for (const sweep of step.sweeps) {
      if (sweep.direction === 'UP') this.reclaims.push({ sweep, lowest: sweep.extreme });
    }
    this.reclaims = this.reclaims.filter(
      (reclaim) => step.index - reclaim.sweep.reclaimIndex <= this.params.triggerWithinCandles,
    );

    const choch = step.breaks.find((found) => found.type === 'CHOCH' && found.direction === 'UP');
    this.chochLevel = choch?.level ?? null;
    this.displacementAtr =
      step.displacement?.direction === 'UP' ? step.displacement.rangeAtr : null;
    this.newest = candle;
    this.newestIndex = step.index;
  }

  private candidates(): SweepCandidate[] {
    return this.reclaims.map(({ sweep, lowest }) => ({
      levelId: sweep.levelId,
      level: sweep.level,
      sweepOpenTime: sweep.sweepOpenTime,
      reclaimOpenTime: sweep.reclaimOpenTime,
      candlesSinceReclaim: this.newestIndex - sweep.reclaimIndex,
      lowest,
      depthAtr: sweep.depthAtr,
      wickRatio: sweep.wickRatio,
      divergence: this.divergences.some(
        (found) =>
          found.second.index >= sweep.sweepIndex && found.second.index <= sweep.reclaimIndex,
      ),
    }));
  }

  evaluate(regime: Regime | null): SweepSideEvaluation | null {
    const newest = this.newest;
    if (newest === null) return null;
    const choch = this.quarter.lastChoch;
    const inputs: SweepInputs = {
      regime,
      sweep: chooseSweep(this.candidates(), this.params),
      chochLevel: this.chochLevel,
      displacementAtr: this.displacementAtr,
      choch15mClosedAt: choch?.direction === 'UP' ? choch.openTime + TIMEFRAME_MS['15m'] : null,
    };
    const checks = judgeSweep(inputs, this.params);
    const atr = this.five.atr;
    const { sweep, chochLevel, displacementAtr } = inputs;
    const stop = sweepStop(sweep?.lowest ?? null, atr, this.params);
    if (
      !allSweepChecksPass(checks) ||
      sweep === null ||
      stop === null ||
      atr === null ||
      chochLevel === null ||
      displacementAtr === null
    ) {
      return { checks, setup: null };
    }

    const price = (value: number) => this.sign * value;
    return {
      checks,
      setup: {
        strategyKey: 'sweep_reversal',
        side: this.side,
        setupKey: `sweep_reversal:5m:${sweep.levelId}@${keyTime(sweep.sweepOpenTime)}`,
        at: newest.openTime,
        close: price(newest.c),
        stopLoss: price(stop),
        facts: {
          levelId: sweep.levelId,
          level: price(sweep.level),
          sweepOpenTime: sweep.sweepOpenTime,
          reclaimOpenTime: sweep.reclaimOpenTime,
          sweepLow: price(sweep.lowest),
          depthAtr: sweep.depthAtr,
          wickRatio: sweep.wickRatio,
          candlesSinceReclaim: sweep.candlesSinceReclaim,
          chochLevel: price(chochLevel),
          displacementAtr,
          atr,
          choch15m: choch15mHolds(inputs),
          rsiDivergence: sweep.divergence,
        },
      },
    };
  }
}

export type SweepTimeframe = '5m' | '15m';

/**
 * Strategy B, Liquidity Sweep Reversal (docs/02 section 7.B). Feed it every closed 5m candle with
 * the liquidity levels that apply to it (the levels of the `LiquidityBook` before it is updated
 * with that candle) and every closed 15m candle, each timeframe in time order; `evaluate(regime)`
 * then answers for the newest 5m candle: the rules of each side and, if all hold, the setup with
 * its stop. The regime is the one of the regime classifier (section 5); the strategy only needs
 * to know whether it is a trend.
 *
 * When a 5m and a 15m candle close at the same moment, push both before calling `evaluate()`: the
 * answer then does not depend on the order. Everything is streaming and only looks back, so the
 * answer for a candle never changes when later candles arrive.
 */
export class SweepReversalStrategy {
  private readonly sides: Readonly<Record<Side, SweepSide>>;
  private readonly lastOpenTime: Record<SweepTimeframe, number | null> = {
    '5m': null,
    '15m': null,
  };
  private readonly counts: Record<SweepTimeframe, number> = { '5m': 0, '15m': 0 };
  private newest: StructureCandle | null = null;

  constructor(private readonly params: SweepReversalParams = SWEEP_REVERSAL_DEFAULTS) {
    assertParams(params);
    this.sides = { BUY: new SweepSide('BUY', params), SELL: new SweepSide('SELL', params) };
  }

  /** How many candles of each timeframe have been pushed. */
  get candles(): Readonly<Record<SweepTimeframe, number>> {
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

  updateFive(candle: StructureCandle, levels: readonly LiquidityLevel[] = []): void {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime['5m'], candle);
    assertLevels(levels);
    this.lastOpenTime['5m'] = candle.openTime;
    this.counts['5m'] += 1;
    this.newest = candle;
    this.sides.BUY.updateFive(candle, levels);
    this.sides.SELL.updateFive(candle, levels);
  }

  /** The rules and the setup as of the newest 5m candle; null before the first one. */
  evaluate(regime: Regime | null): SweepEvaluation | null {
    const newest = this.newest;
    const buy = this.sides.BUY.evaluate(regime);
    const sell = this.sides.SELL.evaluate(regime);
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
