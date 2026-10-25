import { describe, expect, it } from 'vitest';

import { DEFAULT_SPLIT, halfYears, inPeriod, periodsThrough, readUntil, splitOf } from './splits';

const utc = (year: number, month: number, day = 1): number => Date.UTC(year, month - 1, day);

describe('splitOf', () => {
  it('puts a time in training, validation or test, the start in and the end out', () => {
    expect(splitOf(DEFAULT_SPLIT, utc(2022, 1, 1))).toBe('TRAIN');
    expect(splitOf(DEFAULT_SPLIT, utc(2024, 12, 31))).toBe('TRAIN');
    expect(splitOf(DEFAULT_SPLIT, utc(2025, 1, 1) - 1)).toBe('TRAIN');
    expect(splitOf(DEFAULT_SPLIT, utc(2025, 1, 1))).toBe('VALIDATION');
    expect(splitOf(DEFAULT_SPLIT, utc(2026, 1, 1) - 1)).toBe('VALIDATION');
    expect(splitOf(DEFAULT_SPLIT, utc(2026, 1, 1))).toBe('TEST');
    expect(splitOf(DEFAULT_SPLIT, utc(2026, 10, 1))).toBe('TEST');
  });

  it('has nothing before the training starts', () => {
    expect(splitOf(DEFAULT_SPLIT, utc(2021, 12, 31))).toBeNull();
  });

  it('has periods that follow one another without a gap or an overlap', () => {
    expect(DEFAULT_SPLIT.TRAIN.until).toBe(DEFAULT_SPLIT.VALIDATION.from);
    expect(DEFAULT_SPLIT.VALIDATION.until).toBe(DEFAULT_SPLIT.TEST.from);
  });
});

describe('readUntil', () => {
  it('stops at the end of the period the run goes through, and reads everything only through the test', () => {
    expect(readUntil(DEFAULT_SPLIT, 'TRAIN')).toBe(DEFAULT_SPLIT.VALIDATION.from);
    expect(readUntil(DEFAULT_SPLIT, 'VALIDATION')).toBe(DEFAULT_SPLIT.TEST.from);
    expect(readUntil(DEFAULT_SPLIT, 'TEST')).toBeUndefined();
  });

  it('puts the holdout in 2026 and keeps 2025 for the validation', () => {
    expect(DEFAULT_SPLIT.TRAIN).toMatchObject({
      from: Date.UTC(2022, 0, 1),
      until: Date.UTC(2025, 0, 1),
    });
    expect(DEFAULT_SPLIT.VALIDATION.until).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('periodsThrough', () => {
  it('lists the periods from the training up to and including the last one', () => {
    expect(periodsThrough(DEFAULT_SPLIT, 'TRAIN').map((p) => p.key)).toEqual(['TRAIN']);
    expect(periodsThrough(DEFAULT_SPLIT, 'VALIDATION').map((p) => p.key)).toEqual([
      'TRAIN',
      'VALIDATION',
    ]);
    expect(periodsThrough(DEFAULT_SPLIT, 'TEST').map((p) => p.key)).toEqual([
      'TRAIN',
      'VALIDATION',
      'TEST',
    ]);
  });
});

describe('halfYears', () => {
  it('lists the half years that the range touches, the end out', () => {
    expect(halfYears(utc(2022, 3, 15), utc(2023, 2, 1)).map((p) => p.key)).toEqual([
      '2022H1',
      '2022H2',
      '2023H1',
    ]);
    expect(halfYears(utc(2022, 1, 1), utc(2022, 7, 1)).map((p) => p.key)).toEqual(['2022H1']);
    expect(halfYears(utc(2022, 1, 1), utc(2022, 7, 1) + 1).map((p) => p.key)).toEqual([
      '2022H1',
      '2022H2',
    ]);
  });

  it('gives each half year its own bounds', () => {
    const [first, second] = halfYears(utc(2022, 8, 1), utc(2023, 12, 1));
    expect(first).toEqual({ key: '2022H2', from: utc(2022, 7, 1), until: utc(2023, 1, 1) });
    expect(second).toEqual({ key: '2023H1', from: utc(2023, 1, 1), until: utc(2023, 7, 1) });
  });

  it('has none for an empty range', () => {
    expect(halfYears(utc(2023, 1, 1), utc(2023, 1, 1))).toEqual([]);
  });
});

describe('inPeriod', () => {
  it('takes the items decided in the period, the start in and the end out', () => {
    const items = [utc(2025, 1, 1) - 1, utc(2025, 1, 1), utc(2026, 1, 1) - 1, utc(2026, 1, 1)].map(
      (decidedAt) => ({ decidedAt }),
    );
    expect(inPeriod(items, DEFAULT_SPLIT.VALIDATION).map((i) => i.decidedAt)).toEqual([
      utc(2025, 1, 1),
      utc(2026, 1, 1) - 1,
    ]);
  });
});
