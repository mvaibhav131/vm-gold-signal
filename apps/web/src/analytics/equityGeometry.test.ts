import type { EquityPoint } from '@vmgs/contracts';
import { describe, expect, it } from 'vitest';

import { equityGeometry, niceStep, type PlotBox } from './equityGeometry';

const SQUARE: PlotBox = { width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0 };
const points = (...values: number[]): EquityPoint[] =>
  values.map((netR, i) => ({ t: `2026-01-0${String(i + 1)}T10:00:00Z`, netR }));

describe('niceStep', () => {
  it('is 1, 2 or 5 times a power of ten with at most the asked number of steps', () => {
    expect(niceStep(3, 5)).toBe(1); // 0.6 per step is rounded up to 1
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(8.73, 5)).toBe(2);
    expect(niceStep(40, 5)).toBe(10);
    expect(niceStep(0.8, 5)).toBeCloseTo(0.2, 10);
    expect(niceStep(2, 5)).toBe(0.5);
    for (const range of [0.3, 1, 2.7, 7.4, 12.5, 130]) {
      expect(range / niceStep(range, 5)).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('keeps the step on the boundary of its rounding: 5, 10, 25 and 50 give 1, 2, 5 and 10', () => {
    expect(niceStep(5, 5)).toBe(1);
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(25, 5)).toBe(5);
    expect(niceStep(50, 5)).toBe(10);
    expect(niceStep(26, 5)).toBe(10);
  });

  it('is 1 for an empty or backwards range, never 0 or NaN', () => {
    expect(niceStep(0, 5)).toBe(1);
    expect(niceStep(-3, 5)).toBe(1);
    expect(niceStep(Number.NaN, 5)).toBe(1);
  });
});

describe('equityGeometry', () => {
  it('has nothing to draw without a result', () => {
    expect(equityGeometry([], SQUARE)).toBeNull();
  });

  it('draws the line from 0 R, one equal step of x for each result (checked by hand: 0, 2, 1, 3 on a 100 x 100 box)', () => {
    const g = equityGeometry(points(2, 1, 3), SQUARE);
    // x: 0, 33.3, 66.7, 100 ; y = (1 - value / 3) * 100: 100, 33.3, 66.7, 0
    expect(g?.line).toBe('M0,100 L33.3,33.3 L66.7,66.7 L100,0');
    expect(g?.zeroY).toBe(100);
    expect(g?.last).toEqual({ x: 100, y: 0 });
    expect(g?.yTicks).toEqual([
      { value: 0, y: 100 },
      { value: 1, y: 66.7 },
      { value: 2, y: 33.3 },
      { value: 3, y: 0 },
    ]);
    expect([g?.highest, g?.lowest, g?.final]).toEqual([3, 0, 3]);
  });

  it('shades the fall from the running peak: the peak line forward, the equity line back', () => {
    const g = equityGeometry(points(2, 1, 3), SQUARE);
    // peaks 0, 2, 2, 3
    expect(g?.drawdown).toBe(
      'M0,100 L33.3,33.3 L66.7,33.3 L100,0 L100,0 L66.7,66.7 L33.3,33.3 L0,100 Z',
    );
  });

  it('shades nothing for a curve that only rises (the peak line is the curve) and everything below zero for one that only falls', () => {
    // values 0, 1, 2, 3: the peaks are the values, so the path goes there and back on the same line
    expect(equityGeometry(points(1, 2, 3), SQUARE)?.drawdown).toBe(
      'M0,100 L33.3,66.7 L66.7,33.3 L100,0 L100,0 L66.7,33.3 L33.3,66.7 L0,100 Z',
    );
    // values 0, -1, -2 on a scale from -2 to 0: the peak stays on the top line
    expect(equityGeometry(points(-1, -2), SQUARE)?.drawdown).toBe(
      'M0,0 L50,0 L100,0 L100,100 L50,50 L0,0 Z',
    );
  });

  it('puts the ticks on round values, from below the lowest point to above the highest, also under zero', () => {
    const g = equityGeometry(points(-1, -2), SQUARE);
    expect(g?.yTicks.map((tick) => tick.value)).toEqual([-2, -1.5, -1, -0.5, 0]);
    expect(g?.zeroY).toBe(0);
    expect(g?.last.y).toBe(100);
    const mixed = equityGeometry(points(7.68, -1.05), SQUARE);
    expect(mixed?.yTicks.map((tick) => tick.value)).toEqual([-2, 0, 2, 4, 6, 8]);
  });

  it('keeps a flat curve on the zero line with a scale of its own, and a single result works', () => {
    const flat = equityGeometry(points(0, 0), SQUARE);
    expect(flat?.yTicks.map((tick) => tick.value)).toEqual([0, 1]);
    expect(flat?.zeroY).toBe(100);
    const one = equityGeometry(points(1.4), SQUARE);
    // the scale goes up to 1.5 (steps of 0.5), so 1.4 R is at (1 - 1.4 / 1.5) of the height
    expect(one?.line).toBe('M0,100 L100,6.7');
  });

  it('keeps the margins free for the axis labels', () => {
    const box: PlotBox = { width: 200, height: 120, left: 40, right: 10, top: 10, bottom: 10 };
    const g = equityGeometry(points(2, 1, 3), box);
    expect(g?.line.startsWith('M40,')).toBe(true);
    expect(g?.last.x).toBe(190);
    // the top of the scale is at `top`, the bottom at height - bottom
    expect(g?.yTicks[0]?.y).toBe(110);
    expect(g?.yTicks.at(-1)?.y).toBe(10);
  });
});
