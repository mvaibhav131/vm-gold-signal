/** Below this many resolved trades no win rate is shown (02_Signal_Engine, section 13). */
export const EVIDENCE_MIN_SAMPLE = 30;

/** From this many resolved trades the evidence is shown without a "low sample" label. */
export const EVIDENCE_NORMAL_SAMPLE = 100;

export const SAMPLE_LABELS = ['INSUFFICIENT', 'LOW_SAMPLE', 'NORMAL'] as const;
export type SampleLabel = (typeof SAMPLE_LABELS)[number];

export function sampleLabel(n: number): SampleLabel {
  if (n < EVIDENCE_MIN_SAMPLE) return 'INSUFFICIENT';
  if (n < EVIDENCE_NORMAL_SAMPLE) return 'LOW_SAMPLE';
  return 'NORMAL';
}
