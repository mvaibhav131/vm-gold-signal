import { describe, expect, it } from 'vitest';

import type { TickPoint } from '../calendar/gold';
import {
  MOVE_ATR_1M,
  MOVE_ATR_5M,
  MOVE_COOLDOWN_MS,
  MOVE_MAX_GAP_MS,
  MOVE_WINDOW_1M_MS,
  MOVE_WINDOW_5M_MS,
  detectMove,
} from './move';

const NOW = Date.UTC(2026, 9, 23, 16, 17, 0);
const SEC = 1000;

/** A tick `secondsAgo` before now with this mid price and a spread of 0.2. */
const tick = (secondsAgo: number, mid: number, spread = 0.2): TickPoint => ({
  ts: NOW - secondsAgo * SEC,
  bid: Math.round((mid - spread / 2) * 1000) / 1000,
  ask: Math.round((mid + spread / 2) * 1000) / 1000,
});

/** One tick a second from `from` seconds ago to `to` seconds ago, the mid price going linearly from `start` to `end`. */
function between(from: number, to: number, start: number, end: number): TickPoint[] {
  const ticks: TickPoint[] = [];
  for (let s = from; s >= to; s -= 1) {
    ticks.push(tick(s, from === to ? end : start + ((end - start) * (from - s)) / (from - to)));
  }
  return ticks;
}

/** One tick a second from `from` seconds ago to now, the mid price going linearly from `start` to `end`. */
const ramp = (from: number, start: number, end: number): TickPoint[] =>
  between(from, 0, start, end);

describe('detectMove', () => {
  it('has the documented numbers', () => {
    expect(MOVE_ATR_5M).toBe(2);
    expect(MOVE_ATR_1M).toBe(3);
    expect(MOVE_WINDOW_5M_MS).toBe(300_000);
    expect(MOVE_WINDOW_1M_MS).toBe(60_000);
    expect(MOVE_MAX_GAP_MS).toBe(20_000);
    expect(MOVE_COOLDOWN_MS).toBe(600_000);
  });

  it('sees a rise of 2 x ATR(5m) within 5 minutes, and says how long it took', () => {
    // ATR(5m) 3.0: the threshold is 6.0 USD
    const ticks = ramp(240, 4000, 4006);
    expect(detectMove(ticks, NOW, 3, 1.2)).toEqual({
      kind: 'SPIKE_UP',
      windowS: 240,
      moveUsd: 6,
      moveAtr: 2,
      basis: '5m',
      atr: 3,
      at: NOW,
    });
  });

  it('sees a fall in the same way, from the highest price of the window', () => {
    const ticks = ramp(180, 4010, 4002.4);
    expect(detectMove(ticks, NOW, 3, 1.2)).toMatchObject({
      kind: 'SPIKE_DOWN',
      windowS: 180,
      moveUsd: 7.6,
      moveAtr: 2.53,
      basis: '5m',
    });
  });

  it('says nothing for a move a little below the threshold', () => {
    expect(detectMove(ramp(240, 4000, 4005.99), NOW, 3, 1.2)).toBeNull();
    expect(detectMove(ramp(240, 4010, 4004.01), NOW, 3, 1.2)).toBeNull();
  });

  it('sees a rise of 3 x ATR(1m) within a minute, though it is far from 2 x ATR(5m)', () => {
    // ATR(1m) 1.2: the threshold is 3.6 USD; ATR(5m) 3.0 would need 6.0
    const quiet = between(200, 41, 4000, 4000);
    const result = detectMove([...quiet, ...between(40, 0, 4000, 4003.6)], NOW, 3, 1.2);
    expect(result).toMatchObject({
      kind: 'SPIKE_UP',
      basis: '1m',
      moveUsd: 3.6,
      moveAtr: 3,
      atr: 1.2,
    });
    expect(result?.windowS).toBe(40);
    expect(detectMove([...quiet, ...between(40, 0, 4000, 4003.59)], NOW, 3, 1.2)).toBeNull();
  });

  it('reports the window that is further beyond its threshold when both qualify', () => {
    // 9 USD in 50 s: 3.0 x ATR(5m) (1.5 times its threshold) against 7.5 x ATR(1m) (2.5 times)
    const strongOneMinute = detectMove(ramp(50, 4000, 4009), NOW, 3, 1.2);
    expect(strongOneMinute).toMatchObject({ basis: '1m', moveUsd: 9, moveAtr: 7.5 });
    // the same move with a larger ATR(1m): 1.5 times (5m) against 1.0 (1m): the 5-minute one is reported
    const strongFiveMinutes = detectMove(ramp(50, 4000, 4009), NOW, 3, 3);
    expect(strongFiveMinutes).toMatchObject({ basis: '5m', moveUsd: 9, moveAtr: 3 });
    // a tie goes to the 5-minute window
    expect(detectMove(ramp(50, 4000, 4006), NOW, 3, 2)).toMatchObject({ basis: '5m' });
  });

  it('counts a move from the extreme, not from the first tick of the window', () => {
    // down to 3996 and then back up to 4002: the rise is 6 from the low, the drop from the high is 4
    const ticks = [...between(200, 101, 4000, 3996), ...between(100, 0, 3996, 4002)];
    expect(detectMove(ticks, NOW, 3, 12)).toMatchObject({
      kind: 'SPIKE_UP',
      moveUsd: 6,
      windowS: 100,
    });
  });

  it('does not look beyond 5 minutes', () => {
    const ticks = [tick(301, 4000), ...ramp(10, 4001, 4001)];
    expect(detectMove(ticks, NOW, 3, 1.2)).toBeNull();
    expect(detectMove([tick(300, 4000), tick(0, 4006)], NOW, 3, 1.2)).toBeNull();
    expect(detectMove([tick(300, 4000), tick(10, 4000), tick(0, 4006)], NOW, 3, 1.2)).toMatchObject(
      {
        moveUsd: 6,
      },
    );
  });

  it('says nothing without an ATR, or with one that is not above zero', () => {
    const ticks = ramp(240, 4000, 4020);
    expect(detectMove(ticks, NOW, null, null)).toBeNull();
    expect(detectMove(ticks, NOW, 0, 0)).toBeNull();
    expect(detectMove(ticks, NOW, null, 1.2)).toMatchObject({ basis: '1m' });
    expect(detectMove(ticks, NOW, 3, null)).toMatchObject({ basis: '5m' });
  });

  it('says nothing without a fresh tick: the latest must be at most 20 s old', () => {
    const old = ramp(240, 4000, 4010).filter((t) => t.ts <= NOW - 20 * SEC);
    expect(detectMove(old, NOW, 3, 1.2)).not.toBeNull();
    expect(detectMove(old, NOW + 1, 3, 1.2)).toBeNull();
    expect(detectMove([], NOW, 3, 1.2)).toBeNull();
    expect(detectMove([tick(0, 4000)], NOW, 3, 1.2)).toBeNull();
  });

  it('is not fooled by a gap: a jump after 20 seconds of silence is a gap, not a move', () => {
    const gap = [...between(200, 101, 4000, 4000), ...between(60, 0, 4015, 4015)];
    expect(detectMove(gap, NOW, 3, 1.2)).toBeNull();
    // 20 s is allowed, 21 s is not
    const edge = [tick(22, 4000), tick(1, 4010), tick(0, 4010)];
    expect(detectMove(edge, NOW, 3, 1.2)).toBeNull();
    const allowed = [tick(20, 4000), tick(0, 4010)];
    expect(detectMove(allowed, NOW, 3, 1.2)).toMatchObject({ moveUsd: 10, windowS: 20 });
  });

  it('puts the ticks in order and ignores those after now', () => {
    const ticks = ramp(240, 4000, 4006).reverse();
    expect(detectMove(ticks, NOW, 3, 1.2)).toMatchObject({ moveUsd: 6 });
    expect(detectMove([...ticks, tick(-5, 4100)], NOW, 3, 1.2)).toMatchObject({
      moveUsd: 6,
      at: NOW,
    });
  });

  it('uses the mid price: a wide spread alone is no move', () => {
    const wide = ramp(240, 4000, 4000).map((t) => ({ ...t, ask: t.ask + 8 }));
    expect(detectMove(wide, NOW, 3, 1.2)).toBeNull();
    const steady = ramp(240, 4000, 4006).map((t) => ({ ...t, bid: t.bid - 1, ask: t.ask + 1 }));
    expect(detectMove(steady, NOW, 3, 1.2)).toMatchObject({ moveUsd: 6 });
  });

  it('rounds the move to three decimals and the multiple to two', () => {
    const ticks = ramp(100, 4000, 4007.1234);
    expect(detectMove(ticks, NOW, 3, 12)).toMatchObject({ moveUsd: 7.123, moveAtr: 2.37 });
  });
});
