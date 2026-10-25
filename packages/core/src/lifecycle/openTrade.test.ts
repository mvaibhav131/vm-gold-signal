import { describe, expect, it } from 'vitest';

import { MAX_TRADE_GAP_MS, TradeTracker } from '../trade/tracker';
import { DECIDED_AT, SECOND, flipPrice, flipSpec, specOf } from '../trade/test-data';
import type { QuoteTick, TradeSpec } from '../trade/types';
import { OpenTrade, replayTrade, type LifecycleParams } from './openTrade';

type Side = 'BUY' | 'SELL';

const STALE_MS = 10_000;
const VALID_MS = 180_000;
const PARAMS: LifecycleParams = { staleMs: STALE_MS };

/**
 * A trade of the example of docs/02 section 14 (fill 4017.37 at the decision, stop 4010.90, TP1
 * 4023.84, TP2 4030.31, entry valid for 3 minutes), driven with BUY-frame closing-side prices. A SELL
 * is the same trade upside down around 8000, so the same expectations hold for both sides.
 */
class Rig {
  readonly spec: TradeSpec;
  readonly trade: OpenTrade;
  readonly validUntil = DECIDED_AT + VALID_MS;

  constructor(
    readonly side: Side,
    params: LifecycleParams = PARAMS,
    validUntil?: number,
  ) {
    const buy = specOf({ timeStopMin: 120 });
    this.spec = side === 'BUY' ? buy : flipSpec(buy);
    this.trade = new OpenTrade(this.spec, validUntil ?? this.validUntil, params);
  }

  at(seconds: number): number {
    return DECIDED_AT + seconds * SECOND;
  }

  px(price: number): number {
    return this.side === 'BUY' ? price : flipPrice(price);
  }

  quote(seconds: number, price: number): QuoteTick {
    const real = this.px(price);
    const other = this.side === 'BUY' ? real + 0.12 : real - 0.12;
    const [bid, ask] = this.side === 'BUY' ? [real, other] : [other, real];
    return {
      t: this.at(seconds),
      bid: Math.round(bid * 1000) / 1000,
      ask: Math.round(ask * 1000) / 1000,
    };
  }

  tick(seconds: number, price = 4018) {
    return this.trade.observeTick(this.quote(seconds, price));
  }

  clock(seconds: number) {
    return this.trade.observeClock(this.at(seconds));
  }

  get out() {
    const { outcome } = this.trade;
    if (outcome === null) throw new Error('the trade is still open');
    return outcome;
  }
}

describe.each(['BUY', 'SELL'] as const)('an open %s trade', (side) => {
  const rig = (params: LifecycleParams = PARAMS, validUntil?: number) =>
    new Rig(side, params, validUntil);

  describe('while the feed is steady it is the tracker of B20', () => {
    it('follows a win to TP2, with the events of the tracker and the outcome in the last update', () => {
      const r = rig();
      expect(r.tick(5, 4020)).toMatchObject({ events: [], outcome: null, cancelled: null });
      const tp1 = r.tick(10, 4023.84);
      expect(tp1.events.map((event) => event.type)).toEqual(['TP1_HIT', 'STOP_MOVED_TO_ENTRY']);
      expect(tp1.outcome).toBeNull();
      expect(tp1.state).toMatchObject({ status: 'TP1_HIT', stopLossCurrent: r.px(4017.37) });
      const tp2 = r.tick(15, 4030.4);
      expect(tp2.events).toEqual([{ type: 'TP2_HIT', at: r.at(15), price: r.px(4030.31) }]);
      expect(tp2.outcome).toMatchObject({ result: 'WIN', realizedRNet: 1.5, closedAt: r.at(15) });
      expect(r.trade.isOpen).toBe(false);
      expect(r.trade.state.status).toBe('CLOSED');
    });

    it('gives the outcome of a stop only in the update that closed the trade', () => {
      const r = rig();
      const stop = r.tick(5, 4010.9);
      expect(stop.events.map((event) => event.type)).toEqual(['SL_HIT']);
      expect(stop.outcome).toMatchObject({ result: 'LOSS', realizedRNet: -1 });
      const after = r.tick(6, 4030);
      expect(after).toMatchObject({ events: [], outcome: null, cancelled: null });
      expect(after.state.status).toBe('CLOSED');
      expect(r.trade.outcome).toBe(stop.outcome);
    });

    it('is the same as a bare tracker on the same ticks', () => {
      const r = rig();
      const bare = new TradeTracker(r.spec);
      for (const [seconds, price] of [
        [4, 4019],
        [9, 4015],
        [14, 4024],
        [19, 4021],
        [24, 4017.3],
      ] as const) {
        r.tick(seconds, price);
        bare.observeTick(r.quote(seconds, price));
      }
      expect(r.trade.outcome).toEqual(bare.outcome);
      expect(r.trade.state).toEqual(bare.state);
    });
  });

  describe('the ticks that are left out', () => {
    it('a tick of the second of the fill, or before it, is not used', () => {
      const r = rig();
      // 4009 would be a stop if it counted
      expect(r.tick(0, 4009).events).toEqual([]);
      expect(r.tick(-3, 4009).events).toEqual([]);
      expect(r.trade.isOpen).toBe(true);
      expect(r.trade.ignoredTicks).toBe(2);
      expect(r.trade.lastTickAt).toBe(r.at(0));
    });

    it('a tick one second after the fill is used', () => {
      const r = rig();
      expect(r.tick(1, 4009).events.map((event) => event.type)).toEqual(['SL_HIT']);
    });

    it('a tick older than the newest one is not used, one of the same second is', () => {
      const r = rig();
      r.tick(8, 4018);
      expect(r.tick(7, 4009).events).toEqual([]);
      expect(r.trade.ignoredTicks).toBe(1);
      expect(r.trade.lastTickAt).toBe(r.at(8));
      expect(r.tick(8, 4009).events.map((event) => event.type)).toEqual(['SL_HIT']);
    });

    it('a closed trade counts nothing more', () => {
      const r = rig();
      r.tick(5, 4010.9);
      r.tick(6, 4018);
      expect(r.trade.ignoredTicks).toBe(0);
    });
  });

  describe('cancelled: the feed went stale while the entry was valid', () => {
    it('a first tick later than the stale limit cancels the signal, at the instant it went stale', () => {
      const r = rig();
      const update = r.tick(11, 4018);
      expect(update.events).toEqual([{ type: 'CANCELLED', at: r.at(10), price: null }]);
      expect(update.cancelled).toEqual({ staleSeconds: 11 });
      expect(update.outcome).toEqual({
        result: 'CANCELLED',
        countsInStats: false,
        closedAt: r.at(10),
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
      expect(update.state.status).toBe('CLOSED');
      expect(r.trade.isOpen).toBe(false);
      expect(r.trade.lastTickAt).toBe(r.at(10));
    });

    it('a silence of exactly the limit is not stale, one millisecond more is', () => {
      const r = rig();
      expect(r.tick(10, 4018)).toMatchObject({ events: [], outcome: null });
      expect(r.tick(20, 4018)).toMatchObject({ events: [], outcome: null });
      const update = r.tick(30.001, 4018);
      expect(update.events).toEqual([{ type: 'CANCELLED', at: r.at(30), price: null }]);
      expect(update.cancelled).toEqual({ staleSeconds: 10 });
    });

    it('is counted from the last tick, in the middle of the window too', () => {
      const r = rig();
      for (let s = 5; s <= 60; s += 5) r.tick(s, 4018);
      const update = r.tick(71, 4018);
      expect(update.events).toEqual([{ type: 'CANCELLED', at: r.at(70), price: null }]);
      expect(update.cancelled).toEqual({ staleSeconds: 11 });
    });

    it('needs the silence to become stale before the entry is no longer valid', () => {
      const late = rig();
      for (let s = 5; s <= 170; s += 5) late.tick(s, 4018);
      // stale from 180 s: the window ends at 180 s, so the silence started after it
      expect(late.tick(185, 4018).events).toEqual([]);
      expect(late.trade.isOpen).toBe(true);

      const inside = rig();
      for (let s = 5; s <= 165; s += 5) inside.tick(s, 4018);
      inside.tick(169, 4018);
      // last tick at 169 s: stale from 179 s, one second before the end of the window
      expect(inside.tick(185, 4018).events).toEqual([
        { type: 'CANCELLED', at: inside.at(179), price: null },
      ]);
    });

    it('can no longer happen once TP1 was hit: a long silence is then judged as a feed gap', () => {
      const r = rig();
      r.tick(5, 4024);
      expect(r.trade.state.status).toBe('TP1_HIT');
      expect(r.tick(30, 4020)).toMatchObject({ events: [], outcome: null });
      const gap = r.tick(91, 4020);
      expect(gap.events).toEqual([{ type: 'DATA_INVALID', at: r.at(91), price: null }]);
      expect(gap.outcome).toMatchObject({ result: 'DATA_INVALID', tp1Hit: true });
      expect(gap.cancelled).toBeNull();
    });

    it('does not apply to a silence after the entry window: it is a gap or nothing', () => {
      const r = rig();
      for (let s = 5; s <= 200; s += 5) r.tick(s, 4018);
      expect(r.tick(230, 4018)).toMatchObject({ events: [], outcome: null });
      expect(r.tick(291, 4018).events.map((event) => event.type)).toEqual(['DATA_INVALID']);
    });

    it('a tick that would hit the stop after a stale silence does not get to: the cancel comes first', () => {
      const r = rig();
      const update = r.tick(15, 4009);
      expect(update.events.map((event) => event.type)).toEqual(['CANCELLED']);
      expect(update.outcome?.result).toBe('CANCELLED');
    });

    it('closes the trade for good: later ticks do nothing', () => {
      const r = rig();
      r.tick(11, 4018);
      expect(r.tick(12, 4009)).toMatchObject({ events: [], outcome: null });
      expect(r.clock(900)).toMatchObject({ events: [], outcome: null });
      expect(r.trade.state.status).toBe('CLOSED');
    });

    it('uses the stale limit it was given', () => {
      const r = rig({ staleMs: 3_000 });
      expect(r.tick(3, 4018).events).toEqual([]);
      expect(r.tick(6.001, 4018).events).toEqual([{ type: 'CANCELLED', at: r.at(6), price: null }]);
    });

    it('does not apply when the entry validity is over before the trade starts', () => {
      const r = rig(PARAMS, DECIDED_AT);
      expect(r.tick(30, 4018)).toMatchObject({ events: [], outcome: null });
    });
  });

  describe('the clock', () => {
    it('does nothing while the feed is not stale, whatever the time says about the past', () => {
      const r = rig();
      r.tick(8, 4018);
      expect(r.clock(18)).toMatchObject({ events: [], outcome: null, cancelled: null });
      expect(r.clock(5)).toMatchObject({ events: [], outcome: null });
      expect(r.trade.isOpen).toBe(true);
    });

    it('cancels a trade whose feed went quiet in the entry window, at the instant it went stale', () => {
      const r = rig();
      r.tick(8, 4018);
      expect(r.clock(18)).toMatchObject({ events: [] });
      const update = r.clock(18.5);
      expect(update.events).toEqual([{ type: 'CANCELLED', at: r.at(18), price: null }]);
      expect(update.cancelled).toEqual({ staleSeconds: 10 });
      expect(update.outcome?.result).toBe('CANCELLED');
      expect(update.state.status).toBe('CLOSED');
    });

    it('closes a trade as DATA_INVALID after more than 60 s of silence, at the instant the limit passed', () => {
      const r = rig();
      for (let s = 5; s <= 200; s += 5) r.tick(s, 4019);
      expect(r.clock(260)).toMatchObject({ events: [], outcome: null });
      const update = r.clock(260.001);
      expect(update.events).toEqual([{ type: 'DATA_INVALID', at: r.at(260), price: null }]);
      expect(update.outcome).toMatchObject({
        result: 'DATA_INVALID',
        closedAt: r.at(260),
        mfeR: 0.252,
      });
      expect(update.cancelled).toBeNull();
      expect(r.trade.lastTickAt).toBe(r.at(260));
    });

    it('after TP1 it is only the gap that counts, never a cancel', () => {
      const r = rig();
      r.tick(5, 4024);
      expect(r.clock(40)).toMatchObject({ events: [], outcome: null });
      expect(r.clock(65)).toMatchObject({ events: [], outcome: null });
      expect(r.clock(66).events).toEqual([{ type: 'DATA_INVALID', at: r.at(65), price: null }]);
    });

    it('a gap seen by the clock and one seen by a tick are the same result, apart from the time', () => {
      const viaClock = rig();
      const viaTick = rig();
      for (const r of [viaClock, viaTick]) for (let s = 5; s <= 200; s += 5) r.tick(s, 4019);
      viaClock.clock(300);
      viaTick.tick(300, 4000);
      expect(viaClock.out).toEqual({ ...viaTick.out, closedAt: viaClock.at(260), durationS: 260 });
    });

    it('a trade that is closed does not move', () => {
      const r = rig();
      r.tick(5, 4010.9);
      expect(r.clock(5000)).toMatchObject({ events: [], outcome: null });
    });

    it('refuses a time that is not a number', () => {
      expect(() => rig().trade.observeClock(Number.NaN)).toThrow(RangeError);
      expect(() => rig().trade.observeTick({ t: Number.NaN, bid: 1, ask: 1 })).toThrow(RangeError);
    });
  });

  describe('replayTrade rebuilds a trade from stored ticks', () => {
    const ticks = (r: Rig): QuoteTick[] => [
      r.quote(5, 4019),
      r.quote(10, 4024),
      r.quote(15, 4021),
      r.quote(20, 4017.3),
      r.quote(25, 4030),
    ];

    it('gives the events, the outcome and the open trade, and stops at the close', () => {
      const r = rig();
      const result = replayTrade(r.spec, r.validUntil, PARAMS, ticks(r));
      expect(result.events.map((event) => event.type)).toEqual([
        'TP1_HIT',
        'STOP_MOVED_TO_ENTRY',
        'SL_HIT',
      ]);
      expect(result.outcome).toMatchObject({ result: 'PARTIAL_WIN', closedAt: r.at(20) });
      expect(result.cancelled).toBeNull();
      expect(result.trade.isOpen).toBe(false);
      expect(result.trade.lastTickAt).toBe(r.at(20));
    });

    it('is the same as feeding the ticks one by one', () => {
      const r = rig();
      const live = rig();
      for (const tick of ticks(r)) live.trade.observeTick(tick);
      const result = replayTrade(r.spec, r.validUntil, PARAMS, ticks(r));
      expect(result.trade.outcome).toEqual(live.trade.outcome);
      expect(result.trade.state).toEqual(live.trade.state);
    });

    it('stays open when the ticks end first, with the state of that moment', () => {
      const r = rig();
      const result = replayTrade(r.spec, r.validUntil, PARAMS, ticks(r).slice(0, 2));
      expect(result.outcome).toBeNull();
      expect(result.trade.isOpen).toBe(true);
      expect(result.trade.state).toMatchObject({ status: 'TP1_HIT' });
    });

    it('reports a cancel with how long the feed was silent', () => {
      const r = rig();
      const result = replayTrade(r.spec, r.validUntil, PARAMS, [
        r.quote(4, 4018),
        r.quote(40, 4018),
      ]);
      expect(result.outcome?.result).toBe('CANCELLED');
      expect(result.cancelled).toEqual({ staleSeconds: 36 });
      expect(result.events).toEqual([{ type: 'CANCELLED', at: r.at(14), price: null }]);
    });
  });
});

describe('an open trade must be set up properly', () => {
  const spec = specOf();
  it('refuses a stale limit that is not above zero, or a gap limit below it', () => {
    expect(() => new OpenTrade(spec, DECIDED_AT + VALID_MS, { staleMs: 0 })).toThrow(RangeError);
    expect(() => new OpenTrade(spec, DECIDED_AT + VALID_MS, { staleMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(
      () => new OpenTrade(spec, DECIDED_AT + VALID_MS, { staleMs: 10_000, maxGapMs: 5_000 }),
    ).toThrow(RangeError);
    expect(
      () => new OpenTrade(spec, DECIDED_AT + VALID_MS, { staleMs: 10_000, maxGapMs: 10_000 }),
    ).not.toThrow();
  });

  it('refuses an entry validity that is not a time', () => {
    expect(() => new OpenTrade(spec, Number.NaN, PARAMS)).toThrow(RangeError);
  });

  it('refuses a spec that makes no sense, as the tracker does', () => {
    expect(
      () => new OpenTrade({ ...spec, riskDistance: 0 }, DECIDED_AT + VALID_MS, PARAMS),
    ).toThrow(RangeError);
  });

  it('starts open, at the fill, with the state of a new trade', () => {
    const trade = new OpenTrade(spec, DECIDED_AT + VALID_MS, PARAMS);
    expect(trade.isOpen).toBe(true);
    expect(trade.outcome).toBeNull();
    expect(trade.lastTickAt).toBe(spec.fillAt);
    expect(trade.ignoredTicks).toBe(0);
    expect(trade.state).toEqual({
      status: 'ACTIVE',
      stopLossCurrent: spec.stopLoss,
      tp1HitAt: null,
      mfeR: 0,
      maeR: 0,
    });
  });

  it('uses the gap limit it is given for the tracker too, and 60 s when it is not given', () => {
    const trade = new OpenTrade(spec, DECIDED_AT, { staleMs: 5_000, maxGapMs: 20_000 });
    const update = trade.observeTick({ t: spec.fillAt + 21_000, bid: 4018, ask: 4018.12 });
    expect(update.events.map((event) => event.type)).toEqual(['DATA_INVALID']);

    const standard = new OpenTrade(spec, DECIDED_AT, PARAMS);
    expect(
      standard.observeTick({ t: spec.fillAt + 60_000, bid: 4018, ask: 4018.12 }).events,
    ).toEqual([]);
    const gap = standard.observeTick({ t: spec.fillAt + 120_001, bid: 4018, ask: 4018.12 });
    expect(gap.events.map((event) => event.type)).toEqual(['DATA_INVALID']);
    expect(MAX_TRADE_GAP_MS).toBe(60_000);
  });
});
