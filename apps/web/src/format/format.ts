import type { EngineSnapshot } from './types';

export type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'info' | 'brand';

export interface Chip {
  text: string;
  tone: Tone;
}

/**
 * Rounds half away from zero to two decimals. `toFixed(2)` goes wrong on values such as 4017.285
 * (binary floats): a price must never show a cent off. Inputs have at most 3 decimals, so the
 * rounding is done on whole thousandths.
 */
export function formatFixed2(value: number): string {
  const thousandths = Math.round(Math.abs(value) * 1000);
  const hundredths = Math.round(thousandths / 10);
  const sign = value < 0 && hundredths > 0 ? '-' : '';
  const whole = Math.trunc(hundredths / 100);
  return `${sign}${String(whole)}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** Prices are stored with 3 decimals and shown with 2, like a trading screen. */
export function formatPrice(value: number): string {
  return formatFixed2(value);
}

export function formatSpread(value: number): string {
  return formatFixed2(value);
}

export function midOf(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

/** `NEW_YORK` becomes `NEW YORK`: labels are upper case words with spaces. */
export function labelOf(code: string): string {
  return code.replaceAll('_', ' ');
}

/**
 * Freshness of the feed. Every state has text, so status never depends on colour alone
 * (05_UI_Spec section 1).
 */
export function freshnessChip(feedState: string, ageMs: number, warmupPct: number): Chip {
  switch (feedState) {
    case 'LIVE':
      return { text: `FRESH ${(ageMs / 1000).toFixed(1)} s`, tone: 'positive' };
    case 'STALE':
      return { text: 'STALE', tone: 'negative' };
    case 'DISCONNECTED':
      return { text: 'DISCONNECTED', tone: 'negative' };
    case 'MARKET_CLOSED':
      return { text: 'MARKET CLOSED', tone: 'neutral' };
    case 'WARMING_UP':
      return { text: `WARMING UP ${String(Math.round(warmupPct))}%`, tone: 'warning' };
    default:
      return { text: labelOf(feedState), tone: 'neutral' };
  }
}

export function engineChip(engine: EngineSnapshot): Chip {
  if (engine.status === 'PAUSED') return { text: 'PAUSED', tone: 'warning' };
  if (!engine.warmup.ready) return { text: 'WARMING UP', tone: 'warning' };
  return { text: 'RUNNING', tone: 'positive' };
}

export function modeChip(mode: string): Chip {
  return mode === 'LIVE' ? { text: 'LIVE', tone: 'positive' } : { text: 'SIMULATED', tone: 'info' };
}

/** `FORWARD-TEST` stays on while no strategy has earned `VALIDATED` (rule C9). */
export function strategyChip(statuses: readonly string[]): Chip {
  const validated = statuses.filter((status) => status === 'VALIDATED').length;
  return validated === 0
    ? { text: 'FORWARD-TEST', tone: 'brand' }
    : { text: `VALIDATED ${String(validated)}`, tone: 'positive' };
}
