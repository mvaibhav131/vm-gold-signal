import { describe, expect, it } from 'vitest';

import { GOLD_TICK_TOLERANCE_MS, goldAfterOf, type TickPoint } from './gold';

const AT = Date.UTC(2026, 9, 23, 12, 30, 0);
const SEC = 1000;
const tick = (offsetSec: number, bid: number, ask: number): TickPoint => ({
  ts: AT + offsetSec * SEC,
  bid,
  ask,
});

describe('goldAfterOf', () => {
  it('is the move of the mid price from the time to 15 s later, and the spread then', () => {
    const ticks = [
      tick(-2, 4000.0, 4000.2),
      tick(0, 4000.5, 4000.7),
      tick(5, 3999.0, 3999.4),
      tick(14, 3997.4, 3997.8),
      tick(16, 3990.0, 3991.0),
    ];
    expect(goldAfterOf(ticks, AT, 15)).toEqual({ seconds: 15, moveUsd: -3.0, spread: 0.4 });
  });

  it('uses the last tick at or before each moment, whatever the order of the ticks', () => {
    const ticks = [tick(15, 4005, 4005.5), tick(0, 4000, 4000.5), tick(14, 4001, 4001.5)];
    expect(goldAfterOf(ticks, AT, 15)).toEqual({ seconds: 15, moveUsd: 5, spread: 0.5 });
  });

  it('rounds the move and the spread to four decimals', () => {
    const ticks = [tick(0, 4000.1, 4000.3), tick(15, 4000.4, 4000.6)];
    expect(goldAfterOf(ticks, AT, 15)).toEqual({ seconds: 15, moveUsd: 0.3, spread: 0.2 });
  });

  it('is null without a tick near the time, or near the moment after it', () => {
    expect(GOLD_TICK_TOLERANCE_MS).toBe(10_000);
    expect(goldAfterOf([], AT, 15)).toBeNull();
    expect(goldAfterOf([tick(15, 4000, 4000.2)], AT, 15)).toBeNull();
    expect(goldAfterOf([tick(0, 4000, 4000.2)], AT, 15)).toBeNull();
    expect(goldAfterOf([tick(-11, 4000, 4000.2), tick(15, 4001, 4001.2)], AT, 15)).toBeNull();
    expect(goldAfterOf([tick(0, 4000, 4000.2), tick(4, 4001, 4001.2)], AT, 15)).toBeNull();
  });

  it('accepts a tick exactly at the edge of the tolerance, and not one millisecond older', () => {
    const edge = { ts: AT - 10_000, bid: 4000, ask: 4000.2 };
    const late = { ts: AT + 5_000, bid: 4001, ask: 4001.2 };
    expect(goldAfterOf([edge, late], AT, 15)).toEqual({ seconds: 15, moveUsd: 1, spread: 0.2 });
    expect(goldAfterOf([{ ...edge, ts: edge.ts - 1 }, late], AT, 15)).toBeNull();
    expect(
      goldAfterOf(
        [
          { ...edge, ts: AT },
          { ...late, ts: AT + 4_999 },
        ],
        AT,
        15,
      ),
    ).toBeNull();
  });

  it('uses the tick that came later when two ticks have the same time', () => {
    const ticks = [tick(0, 4000, 4000.2), tick(15, 3990, 3990.2), tick(15, 3997, 3997.4)];
    expect(goldAfterOf(ticks, AT, 15)).toEqual({ seconds: 15, moveUsd: -2.9, spread: 0.4 });
  });

  it('does not count a tick after the moment, and a tick of the same time as the release is not "after"', () => {
    const ticks = [tick(0, 4000, 4000.2), tick(16, 4010, 4010.2)];
    expect(goldAfterOf(ticks, AT, 15)).toBeNull();
    expect(goldAfterOf([tick(0, 4000, 4000.2)], AT, 0, 5_000)).toBeNull();
  });
});
