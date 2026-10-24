import { assertFinite } from '../indicators/types';
import { assertQuote, roundPrice, roundR } from './round';
import {
  EXIT_PROFILE_RULES,
  type ExitReason,
  type PriceStretch,
  type QuoteTick,
  type TradeEvent,
  type TradeOutcome,
  type TradeSpec,
  type TradeState,
} from './types';

/** A feed gap longer than this during a trade makes its outcome `DATA_INVALID` (02_Signal_Engine section 11). */
export const MAX_TRADE_GAP_MS = 60_000;

const COUNTED = new Set<TradeOutcome['result']>(['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT']);

/** The record of a signal that could not be followed from the start: market data went stale during its entry validity. */
export function cancelledOutcome(closedAt: number): TradeOutcome {
  return {
    result: 'CANCELLED',
    countsInStats: false,
    closedAt,
    exitPrice: null,
    exitReason: 'STALE_BEFORE_ENTRY',
    realizedRGross: null,
    costR: 0,
    realizedRNet: null,
    durationS: 0,
    mfeR: null,
    maeR: null,
    tp1Hit: false,
    tp2Hit: false,
    ambiguous: false,
    isWin: false,
  };
}

/** The prices of a stretch in the frame of a BUY: for a SELL every price is negated and high and low swap. */
interface Frame {
  readonly open: number;
  readonly high: number;
  readonly low: number;
}

/**
 * The outcome of one filled trade (02_Signal_Engine sections 9 and 11), from the prices of its
 * closing side: feed it ticks (`observeTick`) or stretches of bid or ask prices such as bars
 * (`observe`), in time order, from the fill on. It follows the exit profile (EP1_PARTIAL, EP2_SINGLE
 * or EP3_STRUCTURE; the target of EP3 is the `tp1` of the spec) and reports the events of the signal
 * log; the result is `outcome` once the trade is closed.
 *
 * It is written for a BUY (the closing side is the bid). The SELL side runs the same code on negated
 * prices, so SELL is the exact mirror of BUY by construction.
 *
 * Rules:
 * - The stop is hit when the low of the stretch reaches it; it fills at the open of the stretch if
 *   that is already through the stop (a gap, or the price of a tick), else at the stop. A target is
 *   hit when the high reaches it and fills at the target.
 * - A stop and a target crossed in the same stretch: the stop wins, and `ambiguous` is set.
 * - EP1: at TP1 half is closed and the stop moves to the fill; the rest runs to TP2 or the stop.
 * - The time stop closes the trade at the open of the first stretch at or after it, before that
 *   stretch can do anything else.
 * - A gap of more than 60 s between two stretches (or from the fill) closes the trade as `DATA_INVALID`.
 * - Every result is in R: profit over the risk distance of the plan. Costs are the commission, as R.
 */
export class TradeTracker {
  private readonly sign: 1 | -1;
  private readonly fill: number;
  private readonly tp1: number;
  private readonly tp2: number | null;
  private readonly risk: number;
  private readonly share: number;
  private stop: number;
  private status: TradeState['status'] = 'ACTIVE';
  private tp1HitAt: number | null = null;
  private tp2Hit = false;
  private ambiguous = false;
  private lastAt: number;
  private best: number;
  private worst: number;
  private closed: TradeOutcome | null = null;

  constructor(
    private readonly spec: TradeSpec,
    private readonly maxGapMs: number = MAX_TRADE_GAP_MS,
  ) {
    this.sign = spec.side === 'BUY' ? 1 : -1;
    for (const [name, value] of Object.entries({
      fillAt: spec.fillAt,
      fill: spec.fill,
      stopLoss: spec.stopLoss,
      tp1: spec.tp1,
      riskDistance: spec.riskDistance,
      timeStopAt: spec.timeStopAt,
      costR: spec.costR,
    })) {
      assertFinite(value, name);
    }
    this.fill = this.sign * spec.fill;
    this.stop = this.sign * spec.stopLoss;
    this.tp1 = this.sign * spec.tp1;
    this.tp2 = spec.tp2 === null ? null : this.sign * spec.tp2;
    this.risk = spec.riskDistance;
    this.share =
      spec.exitProfile === 'EP1_PARTIAL' ? EXIT_PROFILE_RULES.EP1_PARTIAL.partialShare : 0;
    if (!(this.risk > 0)) throw new RangeError('the risk distance must be above zero');
    if (!(this.stop < this.fill && this.fill < this.tp1)) {
      throw new RangeError(
        'a trade needs its stop beyond the fill on the losing side and its target on the winning side',
      );
    }
    if (spec.exitProfile === 'EP1_PARTIAL') {
      if (this.tp2 === null || !(this.tp1 < this.tp2))
        throw new RangeError('EP1_PARTIAL needs a TP2 beyond TP1');
    } else if (this.tp2 !== null) {
      throw new RangeError(`${spec.exitProfile} has a single target`);
    }
    if (!(spec.timeStopAt > spec.fillAt))
      throw new RangeError('the time stop must be after the fill');
    this.lastAt = spec.fillAt;
    this.best = this.fill;
    this.worst = this.fill;
  }

  /** The working state, as stored in `signal_state`. */
  get state(): TradeState {
    return {
      status: this.closed === null ? this.status : 'CLOSED',
      stopLossCurrent: roundPrice(this.sign * this.stop),
      tp1HitAt: this.tp1HitAt,
      mfeR: roundR((this.best - this.fill) / this.risk),
      maeR: roundR((this.worst - this.fill) / this.risk),
    };
  }

  /** The closing record; null while the trade is open. */
  get outcome(): TradeOutcome | null {
    return this.closed;
  }

  /** A tick: the bid for a BUY, the ask for a SELL. */
  observeTick(tick: QuoteTick): TradeEvent[] {
    assertQuote(tick);
    const price = this.spec.side === 'BUY' ? tick.bid : tick.ask;
    return this.observe({ t: tick.t, open: price, high: price, low: price });
  }

  /** A stretch of closing-side prices (bid for a BUY, ask for a SELL), in real prices. */
  observe(stretch: PriceStretch): TradeEvent[] {
    if (this.closed !== null) return [];
    assertFinite(stretch.t, 'stretch time');
    assertFinite(stretch.open, 'open');
    assertFinite(stretch.high, 'high');
    assertFinite(stretch.low, 'low');
    if (!(stretch.low <= stretch.open && stretch.open <= stretch.high)) {
      throw new RangeError('a stretch needs low <= open <= high');
    }
    if (stretch.t < this.lastAt)
      throw new RangeError('stretches must be in time order, from the fill on');
    const frame: Frame =
      this.sign === 1
        ? { open: stretch.open, high: stretch.high, low: stretch.low }
        : { open: -stretch.open, high: -stretch.low, low: -stretch.high };
    const events: TradeEvent[] = [];
    const { t } = stretch;

    if (t - this.lastAt > this.maxGapMs) {
      this.lastAt = t;
      events.push({ type: 'DATA_INVALID', at: t, price: null });
      this.closeInvalid(t);
      return events;
    }
    this.lastAt = t;

    if (t >= this.spec.timeStopAt) {
      this.reach(frame.open, frame.open);
      events.push({ type: 'TIME_EXIT', at: t, price: this.real(frame.open) });
      this.finish('TIME_EXIT', frame.open, 'TIME_STOP', t);
      return events;
    }
    this.reach(frame.low, frame.high);
    this.evaluate(frame, t, events);
    return events;
  }

  private real(frame: number): number {
    return roundPrice(this.sign * frame);
  }

  private reach(low: number, high: number): void {
    this.worst = Math.min(this.worst, low);
    this.best = Math.max(this.best, high);
  }

  private evaluate(frame: Frame, t: number, events: TradeEvent[]): void {
    let sameStretch = false;
    if (this.status === 'ACTIVE') {
      const stopHit = frame.low <= this.stop;
      const tp1Hit = frame.high >= this.tp1;
      if (stopHit) {
        this.ambiguous = tp1Hit;
        this.stopOut(frame, t, events, 'STOP');
        return;
      }
      if (!tp1Hit) return;
      this.tp1HitAt = t;
      events.push({ type: 'TP1_HIT', at: t, price: this.real(this.tp1) });
      if (this.share === 0) {
        this.finish('WIN', this.tp1, 'TARGET', t);
        return;
      }
      this.status = 'TP1_HIT';
      this.stop = this.fill;
      sameStretch = true;
      events.push({ type: 'STOP_MOVED_TO_ENTRY', at: t, price: this.real(this.fill) });
    }

    const stopHit = frame.low <= this.stop;
    const tp2Hit = this.tp2 !== null && frame.high >= this.tp2;
    if (stopHit) {
      this.ambiguous = tp2Hit || sameStretch;
      this.stopOut(frame, t, events, 'STOP_AT_ENTRY');
      return;
    }
    if (this.tp2 !== null && tp2Hit) {
      this.tp2Hit = true;
      events.push({ type: 'TP2_HIT', at: t, price: this.real(this.tp2) });
      this.finish('WIN', this.tp2, 'TP2', t);
    }
  }

  private stopOut(
    frame: Frame,
    t: number,
    events: TradeEvent[],
    reason: 'STOP' | 'STOP_AT_ENTRY',
  ): void {
    const price = frame.open <= this.stop ? frame.open : this.stop;
    events.push({ type: 'SL_HIT', at: t, price: this.real(price) });
    this.finish(reason === 'STOP' ? 'LOSS' : 'PARTIAL_WIN', price, reason, t);
  }

  /** The gross result in R of leaving at `exit` (frame price): the share closed at TP1 counts at TP1. */
  private grossR(exit: number): number {
    const remainder = (exit - this.fill) / this.risk;
    if (this.tp1HitAt === null || this.share === 0) return remainder;
    return this.share * ((this.tp1 - this.fill) / this.risk) + (1 - this.share) * remainder;
  }

  private finish(
    result: 'WIN' | 'PARTIAL_WIN' | 'LOSS' | 'TIME_EXIT',
    exit: number,
    reason: ExitReason,
    closedAt: number,
  ): void {
    const gross = roundR(this.grossR(exit));
    const net = roundR(gross - this.spec.costR);
    this.closed = {
      result,
      countsInStats: COUNTED.has(result),
      closedAt,
      exitPrice: this.real(exit),
      exitReason: reason,
      realizedRGross: gross,
      costR: roundR(this.spec.costR),
      realizedRNet: net,
      durationS: Math.floor((closedAt - this.spec.fillAt) / 1000),
      mfeR: roundR((this.best - this.fill) / this.risk),
      maeR: roundR((this.worst - this.fill) / this.risk),
      tp1Hit: this.tp1HitAt !== null,
      tp2Hit: this.tp2Hit,
      ambiguous: this.ambiguous,
      isWin: net > 0,
    };
  }

  private closeInvalid(closedAt: number): void {
    this.closed = {
      result: 'DATA_INVALID',
      countsInStats: false,
      closedAt,
      exitPrice: null,
      exitReason: 'DATA_GAP',
      realizedRGross: null,
      costR: 0,
      realizedRNet: null,
      durationS: Math.floor((closedAt - this.spec.fillAt) / 1000),
      mfeR: roundR((this.best - this.fill) / this.risk),
      maeR: roundR((this.worst - this.fill) / this.risk),
      tp1Hit: this.tp1HitAt !== null,
      tp2Hit: this.tp2Hit,
      ambiguous: false,
      isWin: false,
    };
  }
}
