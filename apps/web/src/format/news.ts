import type { MacroImportance, NewsImpact, NewsTopic } from '@vmgs/core';

import { formatFixed, type Tone } from './format';

export const TOPIC_LABELS: Readonly<Record<NewsTopic, string>> = {
  FED_RATES: 'Fed and interest rates',
  USD_DOLLAR: 'US dollar',
  INFLATION_JOBS: 'Inflation and jobs',
  GEOPOLITICS_WAR: 'Geopolitics and war',
  TRUMP_POLICY: 'Trump policy',
  CENTRAL_BANK_GOLD: 'Central-bank gold buying',
  GOLD_DIRECT: 'Gold directly',
  RISK_OFF: 'Risk-off moves',
};

export const IMPACT_LABELS: Readonly<Record<NewsImpact, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

/** Amber for the big ones: red and green are for direction and result only (05_UI_Spec section 1). */
export const IMPACT_TONE: Readonly<Record<NewsImpact, Tone>> = {
  HIGH: 'warning',
  MEDIUM: 'info',
  LOW: 'neutral',
};

export const IMPORTANCE_LABELS: Readonly<Record<MacroImportance, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const IMPORTANCE_TONE: Readonly<Record<MacroImportance, Tone>> = {
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

/** A number with its sign, and no sign for zero: `+1.80`, `-0.80`, `0.00`. */
export function signed(value: number, decimals: 1 | 2): string {
  const text = formatFixed(Math.abs(value), decimals);
  if (Number(text) === 0) return text;
  return `${value < 0 ? '-' : '+'}${text}`;
}

/** A value of a calendar event with its unit: `0.3%`, `180K`, `52.1`. A value that is not there is a dash. */
export function formatEventValue(value: number | null, unit: string | null): string {
  if (value === null) return '\u2013';
  const text = String(Math.round(value * 1000) / 1000);
  if (unit === null || unit === '') return text;
  return unit.length <= 1 ? `${text}${unit}` : `${text} ${unit}`;
}

/** How far the release was from the forecast, in standard deviations of the past surprises: `+1.8σ`. */
export function formatSurprise(sigma: number | null): string {
  if (sigma === null) return '\u2013';
  return `${signed(sigma, 1)}\u03c3`;
}

/** A move of gold in USD and in ATR: `+9.80 USD (+2.8 ATR)`. */
export function formatMove(move: { readonly usd: number; readonly atr: number }): string {
  return `${signed(move.usd, 2)} USD (${signed(move.atr, 1)} ATR)`;
}
