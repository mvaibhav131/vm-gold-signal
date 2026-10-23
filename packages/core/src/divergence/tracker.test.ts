import { describe, expect, it } from 'vitest';

import { Macd, Rsi } from '../indicators/momentum';
import { computeSeries } from '../indicators/types';
import { MarketStructure } from '../structure/marketStructure';
import { mirrored, randomCandles, zigzag } from '../structure/test-data';
import type { StructureCandle } from '../structure/types';
import { DivergenceTracker } from './tracker';
import { DIVERGENCE_DEFAULTS, type Divergence, type DivergenceParams } from './types';

/** Runs the tracker the way the live worker does: structure first, then the tracker with its swing points. */
function drive(
  candles: readonly StructureCandle[],
  params: DivergenceParams = DIVERGENCE_DEFAULTS,
): Divergence[][] {
  const structure = new MarketStructure();
  const tracker = new DivergenceTracker('5m', params);
  return candles.map((candle) => {
    structure.update(candle);
    return [...tracker.update(candle, structure)];
  });
}

const all = (updates: readonly Divergence[][]) => updates.flat();
const at = (updates: readonly Divergence[][], index: number) => updates[index] ?? [];

// Steps of 4 candles a leg: the swing lows are exactly at the turning points, confirmed 2 candles later.
// 150 -> 160 -> 150 -> 160 -> 100 (candle 16, a steep fall) -> 130 -> 98 (candle 24, a lower low after a gentler fall)
const BULL_REGULAR = [150, 160, 150, 160, 100, 130, 98, 120];
// a rising path whose pullbacks get sharper: the lows 112, 118 and 120 (candles 16, 24, 32) rise while RSI falls
const BULL_HIDDEN = [100, 112, 106, 118, 112, 124, 118, 136, 120, 132];
// the same as BULL_REGULAR after 40 candles of sideways moves, so that the MACD histogram exists at both lows
const BULL_LONG = [150, 160, 150, 160, 150, 160, 150, 160, 150, 160, 100, 130, 98, 120];

describe('DivergenceTracker: regular divergence', () => {
  const candles = zigzag(BULL_REGULAR, 4);
  const closes = candles.map((c) => c.c);

  it('reports a bullish divergence on the candle that confirms the second low, and on no other', () => {
    const updates = drive(candles);
    expect(updates.map((u) => u.length)).toEqual(candles.map((_, i) => (i === 26 ? 1 : 0)));
    expect(at(updates, 26)[0]).toMatchObject({
      id: '5mDIV:RSI:REGULAR:UP:16:24',
      source: 'RSI',
      kind: 'REGULAR',
      direction: 'UP',
      index: 26,
      first: { index: 16 },
      second: { index: 24 },
    });
    expect(at(updates, 26)[0]?.openTime).toBe(candles[26]?.openTime);
  });

  it('uses the RSI at the candle of each swing low, not at the candle that confirmed it', () => {
    const found = at(drive(candles), 26)[0];
    const rsi = computeSeries(new Rsi(), closes);
    expect(found?.first.value).toBe(rsi[16]);
    expect(found?.second.value).toBe(rsi[24]);
    // by hand: by candle 14 there are 14 changes, gains of 8 x 2.5 = 20 and losses of 4 x 2.5 + 2 x 15 = 40, so RSI is
    // 100 - 100 / (1 + 0.5) = 33.3; two more falls of 15 with Wilder smoothing give 26.26 and then 21.38 at candle 16
    expect(found?.first.value).toBeCloseTo(21.378874, 5);
    expect(rsi[18]).toBeGreaterThan(30); // the value at the confirming candle is another number
    expect(rsi[26]).toBeGreaterThan(35);
  });

  it('gives the prices of the swing points (the lows of their candles)', () => {
    const found = at(drive(candles), 26)[0];
    expect(found?.first.price).toBeCloseTo(99.6, 9);
    expect(found?.second.price).toBeCloseTo(97.6, 9);
  });

  it('gives the bearish divergence of the mirrored path, with the mirrored RSI', () => {
    const mirroredCandles = zigzag(mirrored(BULL_REGULAR), 4);
    const found = at(drive(mirroredCandles), 26);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: '5mDIV:RSI:REGULAR:DOWN:16:24', direction: 'DOWN' });
    expect(found[0]?.first.value).toBeCloseTo(100 - 21.378874, 5);
  });

  it('is nothing while the RSI is warming up', () => {
    // swing lows at candles 3 and 9 with a lower low and nothing to compare: RSI(14) starts at candle 14
    expect(all(drive(zigzag([140, 100, 125, 98, 115], 3)))).toEqual([]);
  });

  it('reads the zone and the span from the parameters', () => {
    const zone = { ...DIVERGENCE_DEFAULTS.zone, RSI: { low: 15, high: 85 } };
    expect(all(drive(candles, { ...DIVERGENCE_DEFAULTS, zone }))).toEqual([]); // RSI at the first low is 21.4
    expect(all(drive(candles, { ...DIVERGENCE_DEFAULTS, minSpan: 9 }))).toEqual([]);
    expect(all(drive(candles, { ...DIVERGENCE_DEFAULTS, maxSpan: 7 }))).toEqual([]);
    expect(all(drive(candles, { ...DIVERGENCE_DEFAULTS, minSpan: 8, maxSpan: 8 }))).toHaveLength(1);
  });
});

describe('DivergenceTracker: hidden divergence', () => {
  it('finds each pair of consecutive lows whose price rises while the RSI falls', () => {
    const updates = drive(zigzag(BULL_HIDDEN, 4));
    expect(all(updates).map((d) => d.id)).toEqual([
      '5mDIV:RSI:HIDDEN:UP:16:24',
      '5mDIV:RSI:HIDDEN:UP:24:32',
    ]);
    expect(at(updates, 26)).toHaveLength(1);
    expect(at(updates, 34)).toHaveLength(1);
  });

  it('finds the bearish ones in the mirror', () => {
    const updates = drive(zigzag(mirrored(BULL_HIDDEN, 260), 4));
    expect(all(updates).map((d) => d.id)).toEqual([
      '5mDIV:RSI:HIDDEN:DOWN:16:24',
      '5mDIV:RSI:HIDDEN:DOWN:24:32',
    ]);
  });
});

describe('DivergenceTracker: the MACD histogram', () => {
  const candles = zigzag(BULL_LONG, 4);
  const closes = candles.map((c) => c.c);

  it('is reported after the RSI one, from the histogram at the swing low candles', () => {
    const updates = drive(candles);
    expect(all(updates).map((d) => d.id)).toEqual([
      '5mDIV:RSI:REGULAR:UP:40:48',
      '5mDIV:MACDH:REGULAR:UP:40:48',
    ]);
    const macd = at(updates, 50)[1];
    const histogram = computeSeries(new Macd(), closes).map((m) => m?.histogram ?? null);
    expect(macd).toMatchObject({ source: 'MACD_HISTOGRAM', index: 50 });
    expect(macd?.first.value).toBe(histogram[40]);
    expect(macd?.second.value).toBe(histogram[48]);
    expect(macd?.first.value).toBeLessThan(0);
  });

  it('is the mirror image for highs', () => {
    const ids = all(drive(zigzag(mirrored(BULL_LONG, 260), 4))).map((d) => d.id);
    expect(ids).toEqual(['5mDIV:RSI:REGULAR:DOWN:40:48', '5mDIV:MACDH:REGULAR:DOWN:40:48']);
  });
});

describe('DivergenceTracker: the series', () => {
  it('answers the same at a candle with or without the candles that come later', () => {
    const candles = randomCandles(5, 600);
    expect(JSON.stringify(drive(candles).slice(0, 400))).toBe(
      JSON.stringify(drive(candles.slice(0, 400))),
    );
  });

  it('finds all four kinds on a long random series', () => {
    const seen = new Set<string>();
    for (const seed of [31, 32, 33]) {
      for (const d of all(drive(randomCandles(seed, 1500)))) {
        seen.add(`${d.source}:${d.kind}:${d.direction}`);
      }
    }
    for (const source of ['RSI', 'MACD_HISTOGRAM']) {
      for (const kind of ['REGULAR', 'HIDDEN']) {
        for (const direction of ['UP', 'DOWN']) {
          expect(seen.has(`${source}:${kind}:${direction}`), `${source} ${kind} ${direction}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('counts the candles and refuses one that is out of order or malformed', () => {
    const structure = new MarketStructure();
    const tracker = new DivergenceTracker('5m');
    const [first, second] = zigzag([100, 101, 102], 1);
    if (!first || !second) throw new Error('fixture');
    expect(tracker.count).toBe(0);
    structure.update(second);
    tracker.update(second, structure);
    expect(tracker.count).toBe(1);
    expect(() => tracker.update(first, structure)).toThrow(RangeError);
    expect(() =>
      tracker.update({ ...second, openTime: second.openTime + 300_000, h: 1, l: 2 }, structure),
    ).toThrow(RangeError);
    expect(tracker.count).toBe(1);
  });
});
