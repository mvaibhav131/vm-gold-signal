import type { EngineSnapshot } from './types';

export type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'info' | 'brand';

export interface Chip {
  text: string;
  tone: Tone;
}

/**
 * Rounds half away from zero to 0 to 3 decimals. `toFixed` goes wrong on values such as 4017.285
 * at two decimals (binary floats): a price must never show a digit off. Inputs have at most 3
 * decimals (the stored precision), so the rounding is done on whole thousandths.
 */
export function formatFixed(value: number, decimals: 0 | 1 | 2 | 3): string {
  const thousandths = Math.round(Math.abs(value) * 1000);
  const units = Math.round(thousandths / 10 ** (3 - decimals));
  const scale = 10 ** decimals;
  const sign = value < 0 && units > 0 ? '-' : '';
  const whole = String(Math.trunc(units / scale));
  return decimals === 0
    ? `${sign}${whole}`
    : `${sign}${whole}.${String(units % scale).padStart(decimals, '0')}`;
}

/** Prices and spreads are shown with the 3 decimals they are stored with (owner decision). */
export function formatPrice(value: number): string {
  return formatFixed(value, 3);
}

export function formatSpread(value: number): string {
  return formatFixed(value, 3);
}

/** The mid price, rounded half up to 3 decimals on whole thousandths (no float drift). */
export function midOf(bid: number, ask: number): number {
  const sum = Math.round(bid * 1000) + Math.round(ask * 1000);
  return Math.round(sum / 2) / 1000;
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

/**
 * The engine chip. A feed that is stale or down blocks new signals even though the engine itself
 * is running, so the chip says so (scenario E3: "engine shows blocked").
 */
export function engineChip(engine: EngineSnapshot, feedState?: string): Chip {
  if (engine.status === 'PAUSED') return { text: 'PAUSED', tone: 'warning' };
  if (feedState === 'STALE' || feedState === 'DISCONNECTED') {
    return { text: 'BLOCKED: NO DATA', tone: 'negative' };
  }
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
