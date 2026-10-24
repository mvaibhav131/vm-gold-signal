import type { BreakdownDimension } from '@vmgs/contracts';
import { STRATEGY_KEYS } from '@vmgs/core';

import { STRATEGY_LABELS } from '../format/signal';

export const DIMENSION_LABELS: Readonly<Record<BreakdownDimension, string>> = {
  strategy: 'Strategy',
  side: 'Side',
  session: 'Session',
  regime: 'Regime',
  volatility: 'Volatility',
  news: 'News condition',
  grade: 'Grade',
};

/** `TREND_UP` becomes `Trend up`, `IN_WINDOW` becomes `In window`. */
export function sentenceCase(code: string): string {
  const text = code.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `NEW_YORK` becomes `New York`: a session is a name. */
export function titleCase(code: string): string {
  return code
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** The row label of a breakdown key. A strategy key becomes the strategy name; BUY, SELL and the grade names are shown as they are. */
export function breakdownKeyLabel(by: BreakdownDimension, key: string): string {
  if (by === 'strategy') {
    const strategy = STRATEGY_KEYS.find((candidate) => candidate === key);
    return strategy === undefined ? key : STRATEGY_LABELS[strategy];
  }
  if (by === 'session') return titleCase(key);
  return by === 'side' || by === 'grade' ? key : sentenceCase(key);
}
