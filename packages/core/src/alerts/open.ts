import { EXIT_PROFILE_RULES } from '../trade/types';
import type { ExitProfile, Side } from '../domain';

/** What the open-signal lines need from a signal and its working state. */
export interface OpenFacts {
  readonly side: Side;
  readonly exitProfile: ExitProfile;
  readonly entry: number;
  readonly tp1: number;
  readonly riskDistance: number;
  readonly status: 'ACTIVE' | 'TP1_HIT';
}

/**
 * The result in R if the trade were closed at `closingPrice` (the bid for a BUY, the ask for a
 * SELL) now, before costs: the part of the position that is still open at that price, plus the half
 * that was already closed at TP1 for an `EP1_PARTIAL` trade whose TP1 was hit (as the outcome
 * tracker counts it, 02_Signal_Engine section 9.1).
 */
export function unrealisedR(trade: OpenFacts, closingPrice: number): number {
  const sign = trade.side === 'BUY' ? 1 : -1;
  const remainder = (sign * (closingPrice - trade.entry)) / trade.riskDistance;
  if (trade.status !== 'TP1_HIT' || trade.exitProfile !== 'EP1_PARTIAL') return remainder;
  const share = EXIT_PROFILE_RULES.EP1_PARTIAL.partialShare;
  return (
    share * ((sign * (trade.tp1 - trade.entry)) / trade.riskDistance) + (1 - share) * remainder
  );
}

/**
 * The risk that open signals carry, in R: a signal whose stop is still at its stop-loss risks 1 R, one
 * that hit TP1 has its stop at the entry and risks nothing more (the half it banked is kept).
 */
export function openRiskR(statuses: readonly ('ACTIVE' | 'TP1_HIT')[]): number {
  return statuses.filter((status) => status === 'ACTIVE').length;
}
