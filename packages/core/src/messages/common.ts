import { CAUSE_CATEGORY_OF, type CauseCode } from '../domain';
import { STRATEGY_NAMES } from '../explain/names';
import { roundTo } from '../trade/round';
import type { CauseEvidence, SignalRef } from './types';
import type { Words } from './words';

/** `#S-0042`: the public number of a signal. */
export const signalTag = (seq: number): string => `#S-${String(seq).padStart(4, '0')}`;

/**
 * The first line of every message about a signal (rule C8 and C9): replay data says `SIMULATED`, a
 * strategy that is not validated yet says `FORWARD-TEST (paper)`. The line that opens a new signal
 * also carries the reminder that the owner places the order by hand.
 */
export function labelLine(signal: SignalRef, w: Words, withNote: boolean): string {
  if (signal.mode !== 'LIVE') {
    return withNote ? `${w.simulatedLabel} | ${w.simulatedNote}` : w.simulatedLabel;
  }
  const label = signal.strategyStatus === 'VALIDATED' ? w.validatedLabel : w.paperLabel;
  return withNote ? `${label} | ${w.manualOnly}` : label;
}

/** `Trend Pullback v0.1.0`. */
export const strategyText = (signal: SignalRef): string =>
  `${STRATEGY_NAMES[signal.strategyKey]} v${signal.strategyVersion}`;

/** The reward of a level in R: how many times the risk distance it lies from the entry. */
export const rewardR = (signal: SignalRef, level: number): number =>
  Math.abs(level - signal.entry) / signal.riskDistance;

/** `maxFavourableR` becomes `max favourable R`: the numbers behind a cause are stored with code names. */
export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b(r|usd|atr|tp1|tp2|htf)\b/g, (word) => word.toUpperCase());
}

function valueText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(roundTo(value, 2)) : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const parts = value.flatMap((item: unknown) => {
      const text = valueText(item);
      return text === null ? [] : [text];
    });
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

/** The numbers behind a cause as one line: `max favourable R 0.2, candles 4`. Nested values are left out. */
export function evidenceText(evidence: CauseEvidence): string {
  return Object.entries(evidence)
    .flatMap(([key, value]) => {
      const text = valueText(value);
      return text === null ? [] : [`${humanizeKey(key)} ${text}`];
    })
    .join(', ');
}

/** `NO_FOLLOW_THROUGH (Setup failure)`: the code of a cause with the words of its category. */
export function causeText(code: CauseCode, w: Words): string {
  return `${code} (${w.categoryName[CAUSE_CATEGORY_OF[code]]})`;
}

/** Refuses a message whose levels differ from the levels of the stored signal. */
export function assertLevels(
  signal: SignalRef,
  levels: {
    readonly entry: number;
    readonly maxValidEntry: number;
    readonly stop: number;
    readonly tp1: number;
    readonly tp2: number | null;
    readonly riskUsd: number;
  },
): void {
  const same =
    levels.entry === signal.entry &&
    levels.maxValidEntry === signal.maxValidEntry &&
    levels.stop === signal.stopLoss &&
    levels.tp1 === signal.tp1 &&
    levels.tp2 === signal.tp2 &&
    levels.riskUsd === signal.riskDistance;
  if (!same) throw new RangeError('the levels of the explanation differ from those of the signal');
}
