import type { FrozenHeadline } from '@vmgs/contracts';
import type { MarketEventKind } from '@vmgs/core';

const IMPACT_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 } as const;

/**
 * The headlines of a move as "possible causes": the classified ones first, by impact and then the
 * newest first; the unclassified ones (timing only) after them, the newest first.
 */
export function rankPossibleCauses(headlines: readonly FrozenHeadline[]): FrozenHeadline[] {
  const published = (headline: FrozenHeadline) =>
    headline.publishedAt === null ? -Infinity : Date.parse(headline.publishedAt);
  return [...headlines].sort((a, b) => {
    if (a.classified !== b.classified) return a.classified ? -1 : 1;
    const impact = (IMPACT_RANK[b.impact ?? 'LOW'] - IMPACT_RANK[a.impact ?? 'LOW']) | 0;
    if (a.classified && impact !== 0) return impact;
    return published(b) - published(a);
  });
}

/** `5 min`, `1 min`, `45 s`: the window in which gold moved. */
export function windowLabel(windowS: number): string {
  return windowS >= 60 && windowS % 60 === 0
    ? `${String(windowS / 60)} min`
    : `${String(windowS)} s`;
}

/** A 1-minute window is measured against the ATR of the 1-minute candles, a longer one against the 5-minute ATR (02_Signal_Engine section 16). */
export function atrBasis(windowS: number): '1m' | '5m' {
  return windowS <= 60 ? '1m' : '5m';
}

/** The size of a move with the sign of its direction: `+9.80 USD`, `-7.20 USD`. */
export function signedMoveUsd(kind: MarketEventKind, moveUsd: number): string {
  const text = (Math.round(Math.abs(moveUsd) * 100) / 100).toFixed(2);
  return `${kind === 'SPIKE_UP' ? '+' : '-'}${text} USD`;
}
