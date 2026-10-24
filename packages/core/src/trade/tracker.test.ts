import { describe, expect, it } from 'vitest';

import { MAX_TRADE_GAP_MS, TradeTracker, cancelledOutcome } from './tracker';
import { DECIDED_AT, SECOND, flipPrice, flipSpec, specOf } from './test-data';
import type { RiskParams, TradeEvent, TradeSpec } from './types';

type Side = 'BUY' | 'SELL';
type EventType = TradeEvent['type'];

/**
 * A trade of the example of docs/02 section 14 (fill 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31,
 * R 6.47) driven with BUY-frame prices. A SELL is the same trade seen upside down around 8000, with
 * the quotes and bars turned into real SELL prices, so the same expectations hold for both sides.
 */
class Rig {
  readonly spec: TradeSpec;
  readonly tracker: TradeTracker;

  constructor(
    readonly side: Side,
    overrides: Partial<RiskParams> = {},
    input: Parameters<typeof specOf>[1] = {},
    maxGapMs?: number,
  ) {
    const buy = specOf(overrides, input);
    this.spec = side === 'BUY' ? buy : flipSpec(buy);
    this.tracker = new TradeTracker(this.spec, maxGapMs);
  }

  /** A real price from a BUY-frame price. */
  px(price: number): number {
    return this.side === 'BUY' ? price : flipPrice(price);
  }

  at(seconds: number): number {
    return DECIDED_AT + seconds * SECOND;
  }

  /** A tick whose closing-side price is `price` (the bid for a BUY, the ask for a SELL). */
  tick(seconds: number, price: number): TradeEvent[] {
    const real = this.px(price);
    const other = this.side === 'BUY' ? real + 0.12 : real - 0.12;
    const [bid, ask] = this.side === 'BUY' ? [real, other] : [other, real];
    return this.tracker.observeTick({
      t: this.at(seconds),
      bid: Math.round(bid * 1000) / 1000,
      ask: Math.round(ask * 1000) / 1000,
    });
  }

  bar(seconds: number, open: number, high: number, low: number): TradeEvent[] {
    return this.tracker.observe(
      this.side === 'BUY'
        ? { t: this.at(seconds), open, high, low }
        : { t: this.at(seconds), open: this.px(open), high: this.px(low), low: this.px(high) },
    );
  }

  ev(type: EventType, seconds: number, price: number | null): TradeEvent {
    return { type, at: this.at(seconds), price: price === null ? null : this.px(price) };
  }

  get out() {
    const { outcome } = this.tracker;
    if (outcome === null) throw new Error('the trade is still open');
    return outcome;
  }
}

describe.each(['BUY', 'SELL'] as const)('a %s trade', (side) => {
  const rig = (overrides: Partial<RiskParams> = {}, input: Parameters<typeof specOf>[1] = {}) =>
    new Rig(side, overrides, input);

  describe('the stop', () => {
    it('a price above the stop changes nothing, and the stop is a loss of exactly 1R', () => {
      const r = rig();
      expect(r.tick(10, 4015)).toEqual([]);
      expect(r.tracker.state).toEqual({
        status: 'ACTIVE',
        stopLossCurrent: r.px(4010.9),
        tp1HitAt: null,
        mfeR: 0,
        maeR: -0.366,
      });
      expect(r.tick(15, 4010.91)).toEqual([]);
      expect(r.tracker.outcome).toBeNull();
      expect(r.tick(20, 4010.9)).toEqual([r.ev('SL_HIT', 20, 4010.9)]);
      expect(r.out).toEqual({
        result: 'LOSS',
        countsInStats: true,
        closedAt: r.at(20),
        exitPrice: r.px(4010.9),
        exitReason: 'STOP',
        realizedRGross: -1,
        costR: 0,
        realizedRNet: -1,
        durationS: 20,
        mfeR: 0,
        maeR: -1,
        tp1Hit: false,
        tp2Hit: false,
        ambiguous: false,
        isWin: false,
      });
      expect(r.tracker.state.status).toBe('CLOSED');
    });

    it('a gap through the stop fills at the price seen, a loss of more than 1R', () => {
      const r = rig();
      expect(r.tick(5, 4008)).toEqual([r.ev('SL_HIT', 5, 4008)]);
      expect(r.out).toMatchObject({
        result: 'LOSS',
        exitPrice: r.px(4008),
        realizedRGross: -1.448,
        realizedRNet: -1.448,
        maeR: -1.448,
        isWin: false,
      });
    });

    it('the commission makes a loss bigger, and is counted once', () => {
      const r = rig({ commissionUsdPerOz: 0.647 });
      r.tick(5, 4010.9);
      expect(r.out).toMatchObject({ realizedRGross: -1, costR: 0.1, realizedRNet: -1.1 });
    });

    it('the duration is whole seconds from the fill, rounded down', () => {
      const r = rig();
      r.tick(20.999, 4010.9);
      expect(r.out.durationS).toBe(20);
    });
  });

  describe('EP1_PARTIAL', () => {
    it('TP1 closes half and moves the stop to the fill, and a return to it is +0.5R', () => {
      const r = rig();
      expect(r.tick(10, 4023.83)).toEqual([]);
      expect(r.tick(20, 4023.84)).toEqual([
        r.ev('TP1_HIT', 20, 4023.84),
        r.ev('STOP_MOVED_TO_ENTRY', 20, 4017.37),
      ]);
      expect(r.tracker.state).toEqual({
        status: 'TP1_HIT',
        stopLossCurrent: r.px(4017.37),
        tp1HitAt: r.at(20),
        mfeR: 1,
        maeR: 0,
      });
      expect(r.tick(30, 4017.38)).toEqual([]);
      expect(r.tick(40, 4017.37)).toEqual([r.ev('SL_HIT', 40, 4017.37)]);
      expect(r.out).toEqual({
        result: 'PARTIAL_WIN',
        countsInStats: true,
        closedAt: r.at(40),
        exitPrice: r.px(4017.37),
        exitReason: 'STOP_AT_ENTRY',
        realizedRGross: 0.5,
        costR: 0,
        realizedRNet: 0.5,
        durationS: 40,
        mfeR: 1,
        maeR: 0,
        tp1Hit: true,
        tp2Hit: false,
        ambiguous: false,
        isWin: true,
      });
    });

    it('a gap through the stop at the entry loses part of the profit', () => {
      const r = rig();
      r.tick(10, 4023.84);
      r.tick(20, 4014);
      // the rest is closed at 4014: 0.5 x 1R + 0.5 x (4014 - 4017.37) / 6.47
      expect(r.out).toMatchObject({
        result: 'PARTIAL_WIN',
        exitPrice: r.px(4014),
        realizedRGross: 0.24,
        maeR: -0.521,
      });
    });

    it('TP2 wins 1.5R', () => {
      const r = rig();
      r.tick(10, 4023.84);
      expect(r.tick(20, 4030.3)).toEqual([]);
      expect(r.tick(30, 4030.31)).toEqual([r.ev('TP2_HIT', 30, 4030.31)]);
      expect(r.out).toEqual({
        result: 'WIN',
        countsInStats: true,
        closedAt: r.at(30),
        exitPrice: r.px(4030.31),
        exitReason: 'TP2',
        realizedRGross: 1.5,
        costR: 0,
        realizedRNet: 1.5,
        durationS: 30,
        mfeR: 2,
        maeR: 0,
        tp1Hit: true,
        tp2Hit: true,
        ambiguous: false,
        isWin: true,
      });
    });

    it('one tick beyond TP2 passes TP1 and TP2 at once, and fills at the target', () => {
      const r = rig();
      expect(r.tick(10, 4035)).toEqual([
        r.ev('TP1_HIT', 10, 4023.84),
        r.ev('STOP_MOVED_TO_ENTRY', 10, 4017.37),
        r.ev('TP2_HIT', 10, 4030.31),
      ]);
      expect(r.out).toMatchObject({
        result: 'WIN',
        exitPrice: r.px(4030.31),
        realizedRGross: 1.5,
        mfeR: 2.725,
        tp1Hit: true,
        tp2Hit: true,
        ambiguous: false,
      });
    });

    it('the commission turns a small partial win into a counted trade that is not a win', () => {
      const small = rig({ commissionUsdPerOz: 3.2 });
      small.tick(10, 4023.84);
      small.tick(20, 4017.37);
      expect(small.out).toMatchObject({
        realizedRGross: 0.5,
        costR: 0.495,
        realizedRNet: 0.005,
        isWin: true,
      });

      const flat = rig({ commissionUsdPerOz: 3.235 });
      flat.tick(10, 4023.84);
      flat.tick(20, 4017.37);
      expect(flat.out).toMatchObject({
        result: 'PARTIAL_WIN',
        countsInStats: true,
        realizedRNet: 0,
        isWin: false,
      });

      const losing = rig({ commissionUsdPerOz: 3.5 });
      losing.tick(10, 4023.84);
      losing.tick(20, 4017.37);
      expect(losing.out).toMatchObject({ realizedRNet: -0.041, isWin: false });
    });

    it('a net that rounds to zero is not a win', () => {
      const r = rig({ commissionUsdPerOz: 3.2349 });
      r.tick(10, 4023.84);
      r.tick(20, 4017.37);
      expect(r.out).toMatchObject({ realizedRNet: 0, isWin: false });
    });
  });

  describe('EP2_SINGLE and EP3_STRUCTURE', () => {
    it('EP2 wins 1.5R at its single target', () => {
      const r = rig({ exitProfile: 'EP2_SINGLE' });
      expect(r.spec.tp1).toBe(r.px(4027.075));
      expect(r.tick(10, 4027.07)).toEqual([]);
      expect(r.tick(20, 4027.075)).toEqual([r.ev('TP1_HIT', 20, 4027.075)]);
      expect(r.out).toEqual({
        result: 'WIN',
        countsInStats: true,
        closedAt: r.at(20),
        exitPrice: r.px(4027.075),
        exitReason: 'TARGET',
        realizedRGross: 1.5,
        costR: 0,
        realizedRNet: 1.5,
        durationS: 20,
        mfeR: 1.5,
        maeR: 0,
        tp1Hit: true,
        tp2Hit: false,
        ambiguous: false,
        isWin: true,
      });
      expect(r.tracker.state.status).toBe('CLOSED');
    });

    it('EP2 has no partial: the stop stays where it was', () => {
      const r = rig({ exitProfile: 'EP2_SINGLE' });
      r.tick(10, 4015);
      expect(r.tracker.state.stopLossCurrent).toBe(r.px(4010.9));
      r.tick(20, 4010.9);
      expect(r.out).toMatchObject({ result: 'LOSS', tp1Hit: false });
    });

    it.each([
      [4026, 4026, 1.334],
      [4050, 4036.78, 3],
      [4020, 4023.84, 1],
    ])('EP3 with the structure target %s wins at %s, %sR', (target, tp1, gross) => {
      const r = rig({ exitProfile: 'EP3_STRUCTURE' }, { structureTarget: target });
      expect(r.spec.tp1).toBe(r.px(tp1));
      expect(r.tick(10, tp1 - 0.01)).toEqual([]);
      expect(r.tick(20, tp1)).toEqual([r.ev('TP1_HIT', 20, tp1)]);
      expect(r.out).toMatchObject({
        result: 'WIN',
        exitReason: 'TARGET',
        realizedRGross: gross,
        tp2Hit: false,
      });
    });
  });

  describe('the time stop', () => {
    const quick = (change: Partial<RiskParams> = {}) => rig({ timeStopMin: 1, ...change });

    it('closes at the price of the first tick at or after it', () => {
      const r = quick();
      expect(r.tick(30, 4020)).toEqual([]);
      expect(r.tick(59.999, 4020)).toEqual([]);
      expect(r.tick(60, 4020)).toEqual([r.ev('TIME_EXIT', 60, 4020)]);
      expect(r.out).toEqual({
        result: 'TIME_EXIT',
        countsInStats: true,
        closedAt: r.at(60),
        exitPrice: r.px(4020),
        exitReason: 'TIME_STOP',
        realizedRGross: 0.406,
        costR: 0,
        realizedRNet: 0.406,
        durationS: 60,
        mfeR: 0.406,
        maeR: 0,
        tp1Hit: false,
        tp2Hit: false,
        ambiguous: false,
        isWin: true,
      });
    });

    it('a time exit below the fill is not a win', () => {
      const r = quick();
      r.tick(30, 4016);
      r.tick(60, 4015);
      expect(r.out).toMatchObject({ result: 'TIME_EXIT', realizedRNet: -0.366, isWin: false });
    });

    it('comes before the stop and the target of the same tick', () => {
      const stop = quick();
      stop.tick(30, 4016);
      expect(stop.tick(60, 4000)).toEqual([stop.ev('TIME_EXIT', 60, 4000)]);
      expect(stop.out).toMatchObject({
        result: 'TIME_EXIT',
        exitPrice: stop.px(4000),
        realizedRGross: -2.685,
      });

      const target = quick();
      target.tick(30, 4016);
      target.tick(60, 4040);
      expect(target.out).toMatchObject({
        result: 'TIME_EXIT',
        exitPrice: target.px(4040),
        tp1Hit: false,
      });
    });

    it('after TP1 the rest is closed at the price, with the half at TP1', () => {
      const r = quick();
      r.tick(30, 4023.84);
      r.tick(60, 4020);
      expect(r.out).toMatchObject({ result: 'TIME_EXIT', realizedRGross: 0.703, tp1Hit: true });
    });

    it('a bar from the time stop counts only its open', () => {
      const r = quick();
      r.tick(30, 4016);
      expect(r.bar(60, 4018, 4100, 3900)).toEqual([r.ev('TIME_EXIT', 60, 4018)]);
      expect(r.out).toMatchObject({ exitPrice: r.px(4018), mfeR: 0.097, maeR: -0.212 });
    });
  });

  describe('a gap in the feed', () => {
    it('up to 60 s between two ticks is fine, and 60 s from the fill too', () => {
      const r = rig({ timeStopMin: 10 });
      expect(r.tick(60, 4018)).toEqual([]);
      expect(r.tick(120, 4018)).toEqual([]);
      expect(r.tracker.outcome).toBeNull();
    });

    it('more than 60 s makes the trade DATA_INVALID, and the tick after the gap is not used', () => {
      const r = rig({ timeStopMin: 10 });
      r.tick(60, 4018);
      expect(r.tick(120.001, 4000)).toEqual([r.ev('DATA_INVALID', 120.001, null)]);
      expect(r.out).toEqual({
        result: 'DATA_INVALID',
        countsInStats: false,
        closedAt: r.at(120.001),
        exitPrice: null,
        exitReason: 'DATA_GAP',
        realizedRGross: null,
        costR: 0,
        realizedRNet: null,
        durationS: 120,
        mfeR: 0.097,
        maeR: 0,
        tp1Hit: false,
        tp2Hit: false,
        ambiguous: false,
        isWin: false,
      });
    });

    it('is counted from the fill when the first tick is late', () => {
      const r = rig({ timeStopMin: 10 });
      expect(r.tick(61, 4018)).toEqual([r.ev('DATA_INVALID', 61, null)]);
      expect(r.out).toMatchObject({ result: 'DATA_INVALID', durationS: 61, mfeR: 0, maeR: 0 });
    });

    it('keeps what happened before the gap, and charges no commission', () => {
      const r = rig({ timeStopMin: 10, commissionUsdPerOz: 1 });
      r.tick(30, 4023.84);
      r.tick(100, 4023.84);
      expect(r.out).toMatchObject({ result: 'DATA_INVALID', tp1Hit: true, costR: 0, mfeR: 1 });
    });

    it('the limit can be set', () => {
      const r = new Rig(side, { timeStopMin: 10 }, {}, 5000);
      expect(r.tick(5, 4018)).toEqual([]);
      expect(r.tick(10.001, 4018)).toEqual([r.ev('DATA_INVALID', 10.001, null)]);
      expect(MAX_TRADE_GAP_MS).toBe(60_000);
    });
  });

  describe('stretches of prices such as bars', () => {
    it('a stop alone in a bar is a plain loss', () => {
      const r = rig();
      expect(r.bar(10, 4017, 4020, 4010)).toEqual([r.ev('SL_HIT', 10, 4010.9)]);
      expect(r.out).toMatchObject({
        result: 'LOSS',
        exitPrice: r.px(4010.9),
        ambiguous: false,
        mfeR: 0.406,
        maeR: -1.139,
      });
    });

    it('a stop and TP1 in the same bar: the stop wins and the result is flagged', () => {
      const r = rig();
      expect(r.bar(10, 4017, 4025, 4010)).toEqual([r.ev('SL_HIT', 10, 4010.9)]);
      expect(r.out).toMatchObject({
        result: 'LOSS',
        realizedRGross: -1,
        ambiguous: true,
        tp1Hit: false,
        mfeR: 1.179,
        maeR: -1.139,
      });
    });

    it('the same for a single target', () => {
      const r = rig({ exitProfile: 'EP2_SINGLE' });
      r.bar(10, 4017, 4028, 4010);
      expect(r.out).toMatchObject({ result: 'LOSS', ambiguous: true });
    });

    it('a bar that opens through the stop exits at its open', () => {
      const r = rig();
      r.bar(10, 4008, 4009, 4005);
      expect(r.out).toMatchObject({
        exitPrice: r.px(4008),
        realizedRGross: -1.448,
        ambiguous: false,
      });
    });

    it('a bar that opens at the stop exits at the stop', () => {
      const r = rig();
      r.bar(10, 4010.9, 4012, 4010.9);
      expect(r.out).toMatchObject({ exitPrice: r.px(4010.9), realizedRGross: -1 });
    });

    it('TP1 in a bar that stays above the fill is a clean TP1', () => {
      const r = rig();
      expect(r.bar(10, 4018, 4024, 4017.4)).toEqual([
        r.ev('TP1_HIT', 10, 4023.84),
        r.ev('STOP_MOVED_TO_ENTRY', 10, 4017.37),
      ]);
      expect(r.tracker.state.status).toBe('TP1_HIT');
      expect(r.tracker.outcome).toBeNull();
    });

    it('TP1 and a return to the fill in the same bar: the stop at the entry wins and it is flagged', () => {
      const r = rig();
      expect(r.bar(10, 4018, 4024, 4017)).toEqual([
        r.ev('TP1_HIT', 10, 4023.84),
        r.ev('STOP_MOVED_TO_ENTRY', 10, 4017.37),
        r.ev('SL_HIT', 10, 4017.37),
      ]);
      expect(r.out).toMatchObject({
        result: 'PARTIAL_WIN',
        realizedRGross: 0.5,
        ambiguous: true,
        tp1Hit: true,
      });
    });

    it('TP2 and the stop at the entry in the same bar: the stop wins and it is flagged', () => {
      const r = rig();
      r.tick(10, 4024);
      expect(r.bar(20, 4020, 4031, 4017)).toEqual([r.ev('SL_HIT', 20, 4017.37)]);
      expect(r.out).toMatchObject({
        result: 'PARTIAL_WIN',
        realizedRGross: 0.5,
        ambiguous: true,
        tp2Hit: false,
      });
    });

    it('TP1 and TP2 in the same bar that stays above the fill is a clean win', () => {
      const r = rig();
      expect(r.bar(10, 4018, 4031, 4017.5)).toEqual([
        r.ev('TP1_HIT', 10, 4023.84),
        r.ev('STOP_MOVED_TO_ENTRY', 10, 4017.37),
        r.ev('TP2_HIT', 10, 4030.31),
      ]);
      expect(r.out).toMatchObject({ result: 'WIN', realizedRGross: 1.5, ambiguous: false });
    });

    it('a bar that opens through the stop at the entry exits at its open', () => {
      const r = rig();
      r.tick(10, 4024);
      r.bar(20, 4014, 4016, 4012);
      expect(r.out).toMatchObject({
        result: 'PARTIAL_WIN',
        exitPrice: r.px(4014),
        ambiguous: false,
      });
    });

    it('a bar at the time of the fill is accepted, a bar before it is not', () => {
      const r = rig();
      expect(r.bar(0, 4017.37, 4018, 4017)).toEqual([]);
      expect(() => r.bar(-1, 4017.37, 4018, 4017)).toThrow(RangeError);
    });
  });

  describe('the excursions', () => {
    it('follow the best and the worst price, in R, and only grow', () => {
      const r = rig();
      r.tick(5, 4020);
      expect(r.tracker.state).toMatchObject({ mfeR: 0.406, maeR: 0 });
      r.tick(10, 4014);
      expect(r.tracker.state).toMatchObject({ mfeR: 0.406, maeR: -0.521 });
      r.tick(15, 4019);
      r.tick(20, 4015);
      expect(r.tracker.state).toMatchObject({ mfeR: 0.406, maeR: -0.521 });
      r.tick(25, 4022);
      expect(r.tracker.state).toMatchObject({ mfeR: 0.716, maeR: -0.521 });
    });

    it('are never the wrong sign, and never negative zero', () => {
      const r = rig();
      r.tick(5, 4017.37);
      const { mfeR, maeR } = r.tracker.state;
      expect(Object.is(mfeR, 0)).toBe(true);
      expect(Object.is(maeR, 0)).toBe(true);
    });
  });

  describe('a closed trade', () => {
    it('ignores everything after, and keeps its record', () => {
      const r = rig();
      r.tick(5, 4010.9);
      const closed = r.out;
      expect(r.tick(10, 4030)).toEqual([]);
      expect(r.bar(20, 4018, 4040, 4000)).toEqual([]);
      expect(r.tracker.outcome).toBe(closed);
      expect(r.tracker.state.status).toBe('CLOSED');
    });
  });

  describe('the closing side', () => {
    it('is the bid for a BUY and the ask for a SELL, and the other side is not used', () => {
      const r = rig();
      // the quote of a wide spread: the closing price is on the side of the trade's exit
      const wide = (stop: number, target: number) =>
        r.tracker.observeTick(
          side === 'BUY'
            ? { t: r.at(5), bid: stop, ask: target }
            : { t: r.at(5), bid: flipPrice(target), ask: flipPrice(stop) },
        );
      expect(wide(4012, 4040)).toEqual([]);
      expect(wide(4010.9, 4040)).toEqual([r.ev('SL_HIT', 5, 4010.9)]);
    });
  });
});

describe('a spec must make sense', () => {
  const spec = specOf();
  const refuse = (change: Partial<TradeSpec>) => {
    expect(() => new TradeTracker({ ...spec, ...change })).toThrow(RangeError);
  };

  it('needs the stop below the fill and the target above, for a BUY', () => {
    refuse({ stopLoss: spec.fill });
    refuse({ stopLoss: spec.fill + 1 });
    refuse({ tp1: spec.fill });
    refuse({ tp1: spec.fill - 1 });
  });

  it('and the other way round for a SELL', () => {
    const sell = flipSpec(spec);
    const refuseSell = (change: Partial<TradeSpec>) => {
      expect(() => new TradeTracker({ ...sell, ...change })).toThrow(RangeError);
    };
    expect(() => new TradeTracker(sell)).not.toThrow();
    refuseSell({ stopLoss: sell.fill });
    refuseSell({ stopLoss: sell.fill - 1 });
    refuseSell({ tp1: sell.fill });
    refuseSell({ tp1: sell.fill + 1 });
  });

  it('needs a TP2 beyond TP1 for EP1 and none for the others', () => {
    refuse({ tp2: null });
    refuse({ tp2: spec.tp1 });
    refuse({ tp2: spec.tp1 - 1 });
    const single = specOf({ exitProfile: 'EP2_SINGLE' });
    expect(() => new TradeTracker(single)).not.toThrow();
    expect(() => new TradeTracker({ ...single, tp2: single.tp1 + 5 })).toThrow(RangeError);
    const structure = specOf({ exitProfile: 'EP3_STRUCTURE' });
    expect(() => new TradeTracker({ ...structure, tp2: structure.tp1 + 5 })).toThrow(RangeError);
  });

  it('needs a risk above zero, a time stop after the fill and finite numbers', () => {
    refuse({ riskDistance: 0 });
    refuse({ riskDistance: -1 });
    refuse({ timeStopAt: spec.fillAt });
    refuse({ timeStopAt: spec.fillAt - 1 });
    refuse({ fill: Number.NaN });
    refuse({ stopLoss: Number.NaN });
    refuse({ tp1: Number.POSITIVE_INFINITY });
    refuse({ costR: Number.NaN });
    refuse({ fillAt: Number.NaN });
  });
});

describe('prices that make no sense are refused', () => {
  const tracker = () => new TradeTracker(specOf());
  const at = (seconds: number) => DECIDED_AT + seconds * SECOND;

  it('a stretch needs low <= open <= high', () => {
    expect(() => tracker().observe({ t: at(1), open: 4018, high: 4017, low: 4016 })).toThrow(
      RangeError,
    );
    expect(() => tracker().observe({ t: at(1), open: 4015, high: 4018, low: 4016 })).toThrow(
      RangeError,
    );
    expect(() => tracker().observe({ t: at(1), open: 4017, high: 4018, low: 4016 })).not.toThrow();
  });

  it('numbers must be finite', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tracker().observe({ t: bad, open: 4017, high: 4018, low: 4016 })).toThrow(
        RangeError,
      );
      expect(() => tracker().observe({ t: at(1), open: bad, high: 4018, low: 4016 })).toThrow(
        RangeError,
      );
      expect(() => tracker().observe({ t: at(1), open: 4017, high: bad, low: 4016 })).toThrow(
        RangeError,
      );
      expect(() => tracker().observe({ t: at(1), open: 4017, high: 4018, low: bad })).toThrow(
        RangeError,
      );
    }
  });

  it('time must not go backwards, and a quote must make sense', () => {
    const t = tracker();
    t.observeTick({ t: at(10), bid: 4018, ask: 4018.1 });
    expect(() => t.observeTick({ t: at(9), bid: 4018, ask: 4018.1 })).toThrow(RangeError);
    expect(() => t.observeTick({ t: at(11), bid: 4019, ask: 4018 })).toThrow(RangeError);
    expect(() => t.observeTick({ t: at(11), bid: Number.NaN, ask: 4018 })).toThrow(RangeError);
  });

  it('two stretches at the same time are fine', () => {
    const t = tracker();
    t.observeTick({ t: at(10), bid: 4018, ask: 4018.1 });
    expect(() => t.observeTick({ t: at(10), bid: 4018.5, ask: 4018.6 })).not.toThrow();
  });
});

describe('cancelledOutcome', () => {
  it('is a record of a signal that could not be followed, and counts for nothing', () => {
    expect(cancelledOutcome(DECIDED_AT + 5000)).toEqual({
      result: 'CANCELLED',
      countsInStats: false,
      closedAt: DECIDED_AT + 5000,
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
    });
  });
});
