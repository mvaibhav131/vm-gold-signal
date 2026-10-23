import { Atr, INDICATOR_DEFAULTS } from '../indicators/volatility';
import { StructureTracker, type StructureBreak } from './breaks';
import { displacementOf, type Displacement } from './displacement';
import { FvgTracker, type Fvg, type FvgUpdate } from './gaps';
import { OrderBlockTracker, type OrderBlock, type OrderBlockUpdate } from './orderBlocks';
import { SweepTracker, type LiquidityLevel, type SweepReclaim } from './sweeps';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  type Pivot,
  type StructureCandle,
  type StructureParams,
  type StructureState,
} from './types';

export interface MarketStructureUpdate {
  readonly index: number;
  readonly openTime: number;
  /** ATR(14) including this candle, or null during its warm-up. */
  readonly atr: number | null;
  /** The swing high and swing low confirmed by this candle's close. */
  readonly high: Pivot | null;
  readonly low: Pivot | null;
  readonly state: StructureState | null;
  readonly breaks: readonly StructureBreak[];
  readonly displacement: Displacement | null;
  readonly fvg: FvgUpdate;
  readonly orderBlock: OrderBlockUpdate;
  readonly sweeps: readonly SweepReclaim[];
}

/** A displacement and the candle it happened on. */
export interface DisplacementEvent extends Displacement {
  readonly index: number;
  readonly openTime: number;
}

/**
 * Everything of docs/02 section 4 that is read from the candles of one timeframe, in one pass:
 * ATR, swing pivots with HH/HL/LH/LL state, BOS and CHoCH, displacement, fair value gaps, order
 * blocks, and sweep and reclaim at the liquidity levels supplied with each candle. It uses only
 * the candles it has been fed, so the live worker, the backtester and the chart get the same
 * answers, and an answer for candle t never changes when later candles arrive.
 *
 * Candles are treated as a contiguous series: the gate for feed and weekend gaps (docs/02
 * section 6) is applied by the caller.
 */
export class MarketStructure {
  private readonly atrIndicator: Atr;
  private readonly tracker: StructureTracker;
  private readonly gaps: FvgTracker;
  private readonly blocks: OrderBlockTracker;
  private readonly sweepTracker: SweepTracker;
  private latestAtr: number | null = null;
  private displacement: DisplacementEvent | null = null;
  private sweep: SweepReclaim | null = null;

  constructor(
    private readonly params: StructureParams = STRUCTURE_DEFAULTS,
    atrPeriod: number = INDICATOR_DEFAULTS.atrPeriod,
  ) {
    this.atrIndicator = new Atr(atrPeriod);
    this.tracker = new StructureTracker(params.swingK, params.keptPivots);
    this.gaps = new FvgTracker(params.fvg);
    this.blocks = new OrderBlockTracker(params.orderBlock);
    this.sweepTracker = new SweepTracker(params.sweep);
  }

  get count(): number {
    return this.tracker.count;
  }

  get atr(): number | null {
    return this.latestAtr;
  }

  get state(): StructureState | null {
    return this.tracker.state;
  }

  /** Confirmed swing highs and lows, oldest first. */
  get highPivots(): readonly Pivot[] {
    return this.tracker.swings.highPivots;
  }

  get lowPivots(): readonly Pivot[] {
    return this.tracker.swings.lowPivots;
  }

  get activeGaps(): readonly Fvg[] {
    return this.gaps.active;
  }

  get activeBlocks(): readonly OrderBlock[] {
    return this.blocks.active;
  }

  get lastBos(): StructureBreak | null {
    return this.tracker.lastBos;
  }

  get lastChoch(): StructureBreak | null {
    return this.tracker.lastChoch;
  }

  get lastDisplacement(): DisplacementEvent | null {
    return this.displacement;
  }

  get lastSweep(): SweepReclaim | null {
    return this.sweep;
  }

  get swingK(): number {
    return this.params.swingK;
  }

  update(candle: StructureCandle, levels: readonly LiquidityLevel[] = []): MarketStructureUpdate {
    assertCandle(candle);
    const index = this.tracker.count;
    const atr = this.atrIndicator.update(candle);
    this.latestAtr = atr;

    const step = this.tracker.update(candle);
    const displacement = displacementOf(candle, atr, this.params.displacement);
    if (displacement) {
      this.displacement = { ...displacement, index, openTime: candle.openTime };
    }
    const fvg = this.gaps.update(candle, atr);
    const orderBlock = this.blocks.update(candle, displacement?.direction ?? null);
    const sweeps = this.sweepTracker.update(candle, atr, levels);
    const lastSweep = sweeps.at(-1);
    if (lastSweep) this.sweep = lastSweep;

    return {
      index,
      openTime: candle.openTime,
      atr,
      high: step.high,
      low: step.low,
      state: step.state,
      breaks: step.breaks,
      displacement,
      fvg,
      orderBlock,
      sweeps,
    };
  }
}
