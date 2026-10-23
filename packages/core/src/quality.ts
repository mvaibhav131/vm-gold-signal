import type { Grade, GroupState } from './domain';

/** Grade bands of 02_Signal_Engine section 8. The score is a setup-quality measure, not a probability. */
export const GRADE_THRESHOLDS = { moderate: 65, strong: 75, veryStrong: 90 } as const;

/** Group state bands of section 8; null strength means the data was unavailable. */
export const GROUP_STATE_THRESHOLDS = { strong: 0.75, ok: 0.5, weak: 0.25 } as const;

export function groupState(strength: number | null): GroupState {
  if (strength === null) return 'NA';
  if (strength >= GROUP_STATE_THRESHOLDS.strong) return 'STRONG';
  if (strength >= GROUP_STATE_THRESHOLDS.ok) return 'OK';
  if (strength >= GROUP_STATE_THRESHOLDS.weak) return 'WEAK';
  return 'FAIL';
}

/** Returns null below the lowest grade: such a setup cannot become a signal. */
export function qualityGrade(score: number): Grade | null {
  if (score >= GRADE_THRESHOLDS.veryStrong) return 'Very strong';
  if (score >= GRADE_THRESHOLDS.strong) return 'Strong';
  if (score >= GRADE_THRESHOLDS.moderate) return 'Moderate';
  return null;
}
