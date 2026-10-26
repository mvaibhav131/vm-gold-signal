import { Ema, INDICATOR_DEFAULTS, Supertrend } from '@vmgs/core';
import type { OVERLAYS } from '@vmgs/contracts';

import type { StoredCandle } from './reader';

export type Overlay = (typeof OVERLAYS)[number];

const EMA_PERIODS = { ema20: 20, ema50: 50, ema200: 200 } as const;

/**
 * A value is shown only after three times its period of candles (02_Signal_Engine section 2): an exponential average
 * never forgets its start completely, and a chart that shows the engine's numbers must show the ones it trusts.
 */
const TRUST_FACTOR = 3;

/** How many candles an overlay needs before the first one it shows: they are loaded before the ones that are shown. */
export function trustCandles(overlay: Overlay): number {
  return overlay === 'supertrend'
    ? INDICATOR_DEFAULTS.supertrend.period * TRUST_FACTOR
    : EMA_PERIODS[overlay] * TRUST_FACTOR;
}

/** The most candles any of the asked overlays needs before the first shown one. */
export function overlayWarmup(overlays: readonly Overlay[]): number {
  return overlays.reduce((most, overlay) => Math.max(most, trustCandles(overlay)), 0);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The overlays over `candles` (oldest first, with their warm-up in front): one value per candle, null where the
 * indicator is not trusted yet. The same classes the engine runs (`packages/core/src/indicators`), so the line on the
 * chart is the line the strategies read; the supertrend line is the trailing band of the current direction.
 */
export function computeOverlays(
  candles: readonly StoredCandle[],
  overlays: readonly Overlay[],
): Partial<Record<Overlay, (number | null)[]>> {
  const result: Partial<Record<Overlay, (number | null)[]>> = {};
  for (const overlay of overlays) {
    const trusted = trustCandles(overlay);
    const values: (number | null)[] = [];
    if (overlay === 'supertrend') {
      const line = new Supertrend();
      candles.forEach((candle, index) => {
        const value = line.update(candle)?.value ?? null;
        values.push(value === null || index + 1 < trusted ? null : round3(value));
      });
    } else {
      const average = new Ema(EMA_PERIODS[overlay]);
      candles.forEach((candle, index) => {
        const value = average.update(candle.c);
        values.push(value === null || index + 1 < trusted ? null : round3(value));
      });
    }
    result[overlay] = values;
  }
  return result;
}
