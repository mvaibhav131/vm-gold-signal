import { describe, expect, it } from 'vitest';

import type { TickPoint } from '../calendar/gold';
import {
  IMPACT_HORIZONS_MS,
  IMPACT_TICK_TOLERANCE_MS,
  IMPACT_WINDOW_MS,
  impactSampleOf,
  moveSince,
} from './impact';

const AT = Date.UTC(2026, 9, 23, 16, 12, 0);
const SEC = 1000;

/** A tick `offset` seconds after the publication, with this mid price and a spread of 0.2. */
const tick = (offset: number, mid: number, spread = 0.2): TickPoint => ({
  ts: AT + offset * SEC,
  bid: Math.round((mid - spread / 2) * 1000) / 1000,
  ask: Math.round((mid + spread / 2) * 1000) / 1000,
});

/** A tick every 10 seconds from 10 s before to 11 minutes after, gold rising 1 USD a minute from 4000. */
const steady = (): TickPoint[] =>
  Array.from({ length: 67 }, (_, i) => tick(i * 10 - 10, 4000 + (i * 10 - 10) / 60));

describe('impactSampleOf', () => {
  it('has the documented horizons and tolerance', () => {
    expect(IMPACT_HORIZONS_MS).toEqual([120_000, 300_000, 600_000]);
    expect(IMPACT_WINDOW_MS).toBe(600_000);
    expect(IMPACT_TICK_TOLERANCE_MS).toBe(30_000);
  });

  it('is the signed move after 2, 5 and 10 minutes and the largest excursion in the 10 minutes', () => {
    expect(impactSampleOf(steady(), AT)).toEqual({
      move2m: 2,
      move5m: 5,
      move10m: 10,
      maxAbs10m: 10,
    });
  });

  it('shows a fall as negative, and the excursion is how far it went, up or down, from the first price', () => {
    const falling = steady().map((t) => ({ ...t, bid: 8000 - t.bid, ask: 8000 - t.ask }));
    const sample = impactSampleOf(
      falling.map((t) => ({ ts: t.ts, bid: t.ask, ask: t.bid })),
      AT,
    );
    expect(sample).toMatchObject({ move2m: -2, move5m: -5, move10m: -10, maxAbs10m: 10 });
    const dip = [...steady().filter((t) => t.ts !== AT + 300 * SEC), tick(301, 3994)];
    expect(impactSampleOf(dip, AT)?.maxAbs10m).toBe(10);
    const deepDip = [...steady(), tick(305, 3985)];
    expect(impactSampleOf(deepDip, AT)).toMatchObject({ move10m: 10, maxAbs10m: 15 });
  });

  it('uses the last tick at or before the moment, and the mid of its bid and ask', () => {
    const ticks = [
      tick(-3, 4000, 1),
      tick(119, 4001.5, 0.4),
      tick(121, 4003),
      tick(599, 4004),
      tick(601, 4009),
    ];
    expect(impactSampleOf(ticks, AT)).toEqual({
      move2m: 1.5,
      move5m: null,
      move10m: 4,
      maxAbs10m: 4,
    });
  });

  it('is null without a tick near the time, 30 seconds being the edge', () => {
    const later = steady().filter((t) => t.ts >= AT);
    expect(impactSampleOf(later, AT)?.move10m).toBe(10);
    expect(impactSampleOf([tick(-30, 4000), ...later.filter((t) => t.ts > AT)], AT)).not.toBeNull();
    expect(impactSampleOf([tick(-31, 4000), ...later.filter((t) => t.ts > AT)], AT)).toBeNull();
    expect(impactSampleOf([], AT)).toBeNull();
  });

  it('is null without a tick near the 10-minute mark, and leaves a horizon empty that has no tick', () => {
    expect(impactSampleOf([tick(0, 4000), tick(60, 4001)], AT)).toBeNull();
    expect(impactSampleOf([tick(0, 4000), tick(569, 4009.5)], AT)).toBeNull();
    expect(impactSampleOf([tick(0, 4000), tick(570, 4009.5)], AT)).toEqual({
      move2m: null,
      move5m: null,
      move10m: 9.5,
      maxAbs10m: 9.5,
    });
  });

  it('does not count a tick that is not after the time for a horizon, whatever the tolerance', () => {
    const ticks = [tick(-5, 4000), tick(600, 4010)];
    expect(impactSampleOf(ticks, AT, 1e9)).toMatchObject({
      move2m: null,
      move5m: null,
      move10m: 10,
    });
  });

  it('only counts the ticks after the time and up to 10 minutes for the excursion', () => {
    const ticks = [tick(-5, 4000), tick(1, 4003), tick(600, 4010), tick(601, 4050)];
    expect(impactSampleOf(ticks, AT)).toMatchObject({ move10m: 10, maxAbs10m: 10 });
    expect(impactSampleOf([tick(-5, 4000), tick(600, 4010)], AT)?.maxAbs10m).toBe(10);
  });

  it('takes a tick exactly at the time as the price at the time', () => {
    const ticks = [tick(-5, 4000), tick(0, 4020), tick(600, 4010)];
    expect(impactSampleOf(ticks, AT)).toMatchObject({ move10m: -10, maxAbs10m: 10 });
  });

  it('rounds to three decimals', () => {
    const sample = impactSampleOf([tick(0, 4000), tick(600, 4001.23456)], AT);
    expect(sample).toMatchObject({ move10m: 1.235, maxAbs10m: 1.235 });
  });
});

describe('moveSince', () => {
  it('is the move from the time to now in USD and in ATR(5m), and the spread now', () => {
    const ticks = [tick(-4, 4000), tick(60, 4002), tick(118, 4003.8, 0.3)];
    expect(moveSince(ticks, AT, AT + 120 * SEC, 4.2)).toEqual({ usd: 3.8, atr: 0.9, spread: 0.3 });
    expect(moveSince(ticks, AT, AT + 120 * SEC, 4)).toMatchObject({ atr: 0.95 });
  });

  it('shows a fall as negative USD and a positive number of ATR', () => {
    const ticks = [tick(-4, 4000), tick(118, 3996)];
    expect(moveSince(ticks, AT, AT + 120 * SEC, 4)).toMatchObject({ usd: -4, atr: 1 });
  });

  it('has no ATR without one, or with one that is not above zero', () => {
    const ticks = [tick(-4, 4000), tick(118, 4004)];
    expect(moveSince(ticks, AT, AT + 120 * SEC, null)?.atr).toBeNull();
    expect(moveSince(ticks, AT, AT + 120 * SEC, 0)?.atr).toBeNull();
  });

  it('is null without a tick at either moment, or when there is no later tick', () => {
    expect(moveSince([], AT, AT + 120 * SEC, 4)).toBeNull();
    expect(moveSince([tick(-4, 4000)], AT, AT + 120 * SEC, 4)).toBeNull();
    expect(moveSince([tick(118, 4000)], AT, AT + 120 * SEC, 4)).toBeNull();
    expect(moveSince([tick(-40, 4000), tick(118, 4004)], AT, AT + 120 * SEC, 4)).toBeNull();
    expect(moveSince([tick(-4, 4000), tick(60, 4004)], AT, AT + 120 * SEC, 4)).toBeNull();
    expect(moveSince([tick(-4, 4000), tick(60, 4004)], AT, AT + 90 * SEC, 4)).not.toBeNull();
  });
});
