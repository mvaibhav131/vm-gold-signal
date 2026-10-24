import { describe, expect, it, vi } from 'vitest';

import { Backoff, DEFAULT_BACKOFF } from './backoff';
import { seededRandom } from './simulated';

const noJitter = { initialMs: 1_000, factor: 2, capMs: 60_000, jitter: 0 } as const;

describe('Backoff', () => {
  it('draws its jitter from Math.random unless told otherwise', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(new Backoff().next()).toBe(800);
      spy.mockReturnValue(0.5);
      expect(new Backoff().next()).toBe(1_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('doubles the wait each time and stops growing at the cap', () => {
    const backoff = new Backoff(noJitter);
    const waits = Array.from({ length: 9 }, () => backoff.next());
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('uses the documented defaults: 1 s, doubling, capped at 60 s, 20% jitter', () => {
    expect(DEFAULT_BACKOFF).toEqual({ initialMs: 1_000, factor: 2, capMs: 60_000, jitter: 0.2 });
  });

  it('counts the waits it handed out, and starts again after a reset', () => {
    const backoff = new Backoff(noJitter);
    expect(backoff.attempts).toBe(0);
    backoff.next();
    backoff.next();
    expect(backoff.attempts).toBe(2);
    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.next()).toBe(1_000);
  });

  it('varies each wait by up to the jitter either way', () => {
    const low = new Backoff({ ...noJitter, jitter: 0.2, random: () => 0 });
    const middle = new Backoff({ ...noJitter, jitter: 0.2, random: () => 0.5 });
    const high = new Backoff({ ...noJitter, jitter: 0.2, random: () => 0.999999 });
    expect([low.next(), middle.next(), high.next()]).toEqual([800, 1_000, 1_200]);
    expect([low.next(), middle.next(), high.next()]).toEqual([1_600, 2_000, 2_400]);
  });

  it('never waits longer than the cap, jitter included', () => {
    const backoff = new Backoff({ ...noJitter, jitter: 0.5, random: () => 0.999999 });
    for (let i = 0; i < 20; i += 1) expect(backoff.next()).toBeLessThanOrEqual(60_000);
    const atCap = new Backoff({ ...noJitter, jitter: 0.5, random: () => 0 });
    for (let i = 0; i < 20; i += 1) atCap.next();
    expect(atCap.next()).toBe(30_000);
  });

  it('is exact for a seeded random source and differs between seeds', () => {
    const run = (seed: number) => {
      const backoff = new Backoff({ random: seededRandom(seed) });
      return Array.from({ length: 6 }, () => backoff.next());
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    for (const wait of run(7)) {
      expect(Number.isInteger(wait)).toBe(true);
    }
  });

  it('keeps every jittered wait inside its band over many draws', () => {
    const backoff = new Backoff({ random: seededRandom(1) });
    const bands = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
    for (const base of bands) {
      const wait = backoff.next();
      expect(wait).toBeGreaterThanOrEqual(Math.min(60_000, Math.round(base * 0.8)));
      expect(wait).toBeLessThanOrEqual(Math.min(60_000, Math.round(base * 1.2)));
    }
  });

  it('refuses settings that make no sense', () => {
    expect(() => new Backoff({ initialMs: 0 })).toThrow(RangeError);
    expect(() => new Backoff({ factor: 0.5 })).toThrow(RangeError);
    expect(() => new Backoff({ initialMs: 5_000, capMs: 1_000 })).toThrow(RangeError);
    expect(() => new Backoff({ jitter: 1 })).toThrow(RangeError);
    expect(() => new Backoff({ jitter: -0.1 })).toThrow(RangeError);
    expect(() => new Backoff({ factor: 1 })).not.toThrow();
    expect(() => new Backoff({ jitter: 0 })).not.toThrow();
    expect(() => new Backoff({ initialMs: 1_000, capMs: 1_000 })).not.toThrow();
  });

  it('with a factor of 1 waits the same time every time', () => {
    const backoff = new Backoff({ ...noJitter, factor: 1 });
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([1_000, 1_000, 1_000]);
  });
});
