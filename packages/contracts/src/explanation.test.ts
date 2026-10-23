import { describe, expect, it } from 'vitest';

import { evidenceSchema, explanationSchema } from './explanation';
import { evidence, explanation } from './test-fixtures';

describe('evidenceSchema', () => {
  it('round-trips through JSON', () => {
    const parsed = evidenceSchema.parse(evidence());
    expect(evidenceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(evidence());
  });

  it('carries only counts below 30 trades', () => {
    const none = {
      ...evidence(),
      n: 12,
      wins: 7,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
      ci: null,
      expectancyR: null,
      profitFactor: null,
      tp1Rate: null,
      tp2Rate: null,
    };
    expect(evidenceSchema.safeParse(none).success).toBe(true);
    expect(evidenceSchema.safeParse({ ...none, winRate: 0.58 }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...none, ci: [0.3, 0.8] }).success).toBe(false);
  });

  it('rejects a win rate shown without its interval', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), ci: null }).success).toBe(false);
  });

  it('rejects a win rate outside its interval', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), winRate: 0.9 }).success).toBe(false);
  });

  it('rejects an inverted interval', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), ci: [0.69, 0.46] }).success).toBe(false);
  });

  it('requires the sample label to follow n', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), sampleLabel: 'NORMAL' }).success).toBe(false);
    expect(
      evidenceSchema.safeParse({ ...evidence(), n: 150, wins: 90, sampleLabel: 'NORMAL' }).success,
    ).toBe(true);
  });

  it('rejects more wins than trades and unknown fields', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), wins: 65 }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence(), extra: 1 }).success).toBe(false);
  });

  it('allows an undefined profit factor when there were no losses', () => {
    expect(evidenceSchema.safeParse({ ...evidence(), profitFactor: null }).success).toBe(true);
  });
});

describe('explanationSchema', () => {
  it('parses the documented example shape and round-trips', () => {
    const parsed = explanationSchema.parse(explanation());
    expect(explanationSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(explanation());
  });

  it('rejects an unknown quality group, grade or flag', () => {
    const e = explanation();
    expect(
      explanationSchema.safeParse({ ...e, groups: [{ key: 'vibes', state: 'OK', facts: [] }] })
        .success,
    ).toBe(false);
    expect(
      explanationSchema.safeParse({ ...e, quality: { score: 78, grade: 'Great' } }).success,
    ).toBe(false);
    expect(
      explanationSchema.safeParse({ ...e, warnings: [{ code: 'FULL_MOON', text: 'x' }] }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(explanationSchema.safeParse({ ...explanation(), extra: 1 }).success).toBe(false);
  });
});
