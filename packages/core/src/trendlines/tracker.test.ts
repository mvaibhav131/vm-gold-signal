import { describe, expect, it } from 'vitest';

import { MarketStructure } from '../structure/marketStructure';
import { mirrored, randomCandles, zigzag } from '../structure/test-data';
import type { StructureCandle } from '../structure/types';
import { BreakRetestTracker } from './breaks';
import { lineValueAt } from './lines';
import { FIVE_MINUTES, driftCandles } from './test-data';
import { TrendlineTracker, type TrendlineUpdate } from './tracker';

function run(candles: readonly StructureCandle[], tf: '5m' | '15m' = '5m') {
  const structure = new MarketStructure();
  const tracker = new TrendlineTracker(tf);
  const updates = candles.map((candle) => {
    structure.update(candle);
    return tracker.update(candle, structure);
  });
  return { structure, tracker, updates };
}

/** Lows rise 3 every 6 candles (0.5 per candle) and highs 14 above them: a rising channel. */
const RISING = [100, 114, 103, 117, 106, 120, 109, 123, 112, 126, 115, 129, 118, 132, 121];

const summary = (update: TrendlineUpdate) =>
  JSON.stringify({
    lines: update.lines.map((l) => [l.id, l.touches, Number(l.score.toFixed(9))]),
    support: update.support?.id ?? null,
    resistance: update.resistance?.id ?? null,
    supportChannel: update.supportChannel?.id ?? null,
    resistanceChannel: update.resistanceChannel?.id ?? null,
  });

describe('TrendlineTracker: a rising channel (zigzag)', () => {
  const { structure, updates } = run(zigzag(RISING));
  const last = updates.at(-1);

  it('finds the support line through the rising lows, from the oldest low on (hand-checked)', () => {
    // swing lows at candles 6, 12, ..., 36 (price 0.4 under the turning point), all on one line of slope 0.5
    expect(structure.lowPivots.map((p) => p.index)).toEqual([6, 12, 18, 24, 30, 36]);
    expect(last?.support).toMatchObject({
      id: '5mS:6:12',
      touches: 6,
      confirmed: true,
      lastTouchIndex: 36,
    });
    expect(last?.support?.slope).toBeCloseTo(0.5, 9);
    expect(last?.support?.a.price).toBeCloseTo(102.6, 9);
    // every pair of the six lows is a valid line (6 x 5 / 2 = 15): collinear points give several lines
    expect(last?.lines.filter((l) => l.side === 'SUPPORT')).toHaveLength(15);
  });

  it('finds no resistance line, because the highs rise too', () => {
    expect(last?.resistance).toBeNull();
    expect(last?.resistanceChannel).toBeNull();
  });

  it('draws the channel parallel to the support line through the highest high between its two points', () => {
    // highs sit at 3, 9, ..., 39; only the one at candle 9 lies between the lows at 6 and 12
    expect(last?.supportChannel?.anchor.index).toBe(9);
    expect(last?.supportChannel?.touches).toBe(6); // the swing highs from candle 6 on: 9, 15, ..., 39
    expect(last?.supportChannel?.id).toBe('5mS:6:12:channel');
    expect(last?.supportChannel?.offset).toBeCloseTo(117.4 - (102.6 + 0.5 * 3), 9);
  });

  it('has no line before the ATR exists and before there are two swing lows six candles apart', () => {
    expect(updates.slice(0, 13).every((u) => u.lines.length === 0)).toBe(true);
    // the second swing low (candle 12) is confirmed at candle 14
    expect(updates[13]?.lines).toEqual([]);
    expect(updates[14]?.support?.id).toBe('5mS:6:12');
  });

  it('exposes the latest answer and the number of candles', () => {
    const tracker = new TrendlineTracker('5m');
    expect(tracker.value.lines).toEqual([]);
    expect(tracker.count).toBe(0);
  });
});

describe('TrendlineTracker: a falling channel is the mirror image', () => {
  const { updates } = run(zigzag(mirrored(RISING)));
  const last = updates.at(-1);

  it('finds the resistance line over the falling highs and the channel through the lowest low between its points', () => {
    expect(last?.resistance).toMatchObject({ id: '5mR:6:12', touches: 6, confirmed: true });
    expect(last?.resistance?.slope).toBeCloseTo(-0.5, 9);
    expect(last?.support).toBeNull();
    expect(last?.resistanceChannel?.anchor.index).toBe(9);
    expect(last?.resistanceChannel?.touches).toBe(6);
  });
});

describe('TrendlineTracker: a line ends when price closes beyond it', () => {
  it('has no support line after a close more than 0.10 x ATR below every line', () => {
    const candles = zigzag(RISING);
    const drop: StructureCandle = {
      openTime: (candles.at(-1)?.openTime ?? 0) + FIVE_MINUTES,
      o: 121,
      h: 121.5,
      l: 100,
      c: 101,
    };
    const { updates } = run([...candles, drop]);
    expect(updates.at(-2)?.support).not.toBeNull();
    expect(updates.at(-1)?.support).toBeNull();
    expect(updates.at(-1)?.supportChannel).toBeNull();
  });
});

describe('TrendlineTracker with the break and retest tracker', () => {
  it('reports the break of the support line and then its retest from below (a rising channel that gives way)', () => {
    const candles = zigzag(RISING);
    const structure = new MarketStructure();
    const trend = new TrendlineTracker('5m');
    const breaks = new BreakRetestTracker();
    const feed = (candle: StructureCandle) => {
      structure.update(candle);
      const update = trend.update(candle, structure);
      const watch = [update.support, update.resistance].filter((l) => l !== null);
      return breaks.update(candle, structure.atr, watch);
    };
    for (const candle of candles) feed(candle);
    const line = trend.value.support;
    expect(line?.id).toBe('5mS:6:12');
    if (!line) return;

    const n = candles.length;
    // candle number n is the first after the zigzag, n + 1 the next one
    const timeOf = (index: number) =>
      (candles.at(-1)?.openTime ?? 0) + (index - n + 1) * FIVE_MINUTES;
    const at = (index: number) => lineValueAt(line, timeOf(index));
    // a big bearish candle that closes 2.5 below the line
    const breakCandle: StructureCandle = {
      openTime: timeOf(n),
      o: at(n) + 1,
      h: at(n) + 1.2,
      l: at(n) - 3,
      c: at(n) - 2.5,
    };
    const result = feed(breakCandle);
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({ direction: 'DOWN', index: n });
    expect(result.breaks[0]?.line.id).toBe('5mS:6:12');

    // the next candle comes back up to 0.5 below the line (inside the 0.3 x ATR zone) and closes 3 below it
    const retestCandle: StructureCandle = {
      openTime: timeOf(n + 1),
      o: at(n + 1) - 2.5,
      h: at(n + 1) - 0.5,
      l: at(n + 1) - 3.2,
      c: at(n + 1) - 3,
    };
    const retest = feed(retestCandle);
    expect(retest.retests).toHaveLength(1);
    expect(retest.retests[0]).toMatchObject({ breakIndex: n, index: n + 1 });
  });
});

describe('TrendlineTracker: look-ahead, determinism, window', () => {
  const series = {
    random: randomCandles(2026, 700),
    up: driftCandles(31, 700, 0.06),
    down: driftCandles(32, 700, -0.06),
  };

  it.each(Object.entries(series))(
    'never looks ahead (%s): a truncated history gives the start of the full run',
    (_name, candles) => {
      const full = run(candles).updates.map(summary);
      for (const cut of [90, 250, 480]) {
        expect(run(candles.slice(0, cut)).updates.map(summary)).toEqual(full.slice(0, cut));
      }
    },
  );

  it('is deterministic', () => {
    const a = run(series.up).updates.map(summary);
    const b = run(series.up).updates.map(summary);
    expect(a).toEqual(b);
  });

  it('only uses swing points of the last 80 candles', () => {
    const { updates } = run(series.up);
    updates.forEach((update, i) => {
      for (const line of update.lines) expect(line.a.index).toBeGreaterThanOrEqual(i + 1 - 80);
    });
  });

  it('finds lines of both sides, confirmed ones, and channels, in a long run (so the checks above are not vacuous)', () => {
    const all = [series.up, series.down, series.random].flatMap((c) => run(c).updates);
    expect(all.filter((u) => u.support).length).toBeGreaterThan(50);
    expect(all.filter((u) => u.resistance).length).toBeGreaterThan(50);
    expect(all.filter((u) => u.support?.confirmed).length).toBeGreaterThan(10);
    expect(all.filter((u) => u.supportChannel).length).toBeGreaterThan(5);
    expect(all.filter((u) => u.resistanceChannel).length).toBeGreaterThan(5);
  });

  it('refuses candles out of order', () => {
    const tracker = new TrendlineTracker('5m');
    const structure = new MarketStructure();
    const [first, second] = series.up;
    if (!first || !second) throw new Error('fixture');
    structure.update(first);
    tracker.update(first, structure);
    expect(() => {
      tracker.update(first, structure);
    }).toThrow(RangeError);
    expect(tracker.count).toBe(1);
    expect(second.openTime).toBeGreaterThan(first.openTime);
  });
});
