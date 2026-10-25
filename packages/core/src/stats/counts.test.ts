import { describe, expect, it } from 'vitest';

import { EMPTY_COUNTS, addResult, countResults, mergeCounts, type BucketCounts } from './counts';
import { T0, record, recordsOf } from './test-data';

describe('addResult', () => {
  it('counts a win', () => {
    expect(addResult(EMPTY_COUNTS, record('WIN', 1.47))).toEqual({
      n: 1,
      wins: 1,
      winners: 1,
      partials: 0,
      losses: 0,
      timeExits: 0,
      tp1Hits: 1,
      tp2Hits: 1,
      sumR: 1.47,
      sumWinR: 1.47,
      sumLossR: 0,
    });
  });

  it('counts a partial win with its TP1 and no TP2', () => {
    expect(addResult(EMPTY_COUNTS, record('PARTIAL_WIN', 0.46))).toEqual({
      ...EMPTY_COUNTS,
      n: 1,
      winners: 1,
      partials: 1,
      tp1Hits: 1,
      sumR: 0.46,
      sumWinR: 0.46,
    });
  });

  it('counts a loss', () => {
    expect(addResult(EMPTY_COUNTS, record('LOSS', -1.04))).toEqual({
      ...EMPTY_COUNTS,
      n: 1,
      losses: 1,
      sumR: -1.04,
      sumLossR: -1.04,
    });
  });

  it('counts a time exit by the sign of its net R', () => {
    expect(addResult(EMPTY_COUNTS, record('TIME_EXIT', 0.3))).toMatchObject({
      n: 1,
      timeExits: 1,
      winners: 1,
      sumWinR: 0.3,
      sumLossR: 0,
    });
    expect(addResult(EMPTY_COUNTS, record('TIME_EXIT', -0.18))).toMatchObject({
      n: 1,
      timeExits: 1,
      winners: 0,
      sumWinR: 0,
      sumLossR: -0.18,
    });
  });

  it('is not a winner at exactly zero, or when the costs bring a win to zero or below', () => {
    expect(addResult(EMPTY_COUNTS, record('TIME_EXIT', 0))).toMatchObject({
      n: 1,
      winners: 0,
      sumWinR: 0,
      sumLossR: 0,
    });
    expect(addResult(EMPTY_COUNTS, record('PARTIAL_WIN', 0))).toMatchObject({
      partials: 1,
      winners: 0,
    });
    expect(addResult(EMPTY_COUNTS, record('WIN', -0.01))).toMatchObject({
      wins: 1,
      winners: 0,
      sumLossR: -0.01,
    });
  });

  it('counts the targets that were hit whatever the result', () => {
    const counts = addResult(
      addResult(EMPTY_COUNTS, record('TIME_EXIT', 0.1, 0, { tp1Hit: true })),
      record('LOSS', -1, 1, { tp2Hit: true }),
    );
    expect(counts).toMatchObject({ tp1Hits: 1, tp2Hits: 1 });
  });

  it('leaves out a cancelled signal and a data-invalid one: they are in no rate', () => {
    for (const result of ['CANCELLED', 'DATA_INVALID'] as const) {
      expect(addResult(EMPTY_COUNTS, record(result, null))).toBe(EMPTY_COUNTS);
    }
  });

  it('refuses a counted result with no net R, and one that is not a number', () => {
    expect(() => addResult(EMPTY_COUNTS, record('LOSS', null))).toThrow(RangeError);
    expect(() => addResult(EMPTY_COUNTS, record('LOSS', Number.NaN))).toThrow(RangeError);
    expect(() => addResult(EMPTY_COUNTS, record('LOSS', Number.POSITIVE_INFINITY))).toThrow(
      RangeError,
    );
  });

  it('does not change the counts it was given', () => {
    const before = { ...EMPTY_COUNTS };
    addResult(EMPTY_COUNTS, record('WIN', 1));
    expect(EMPTY_COUNTS).toEqual(before);
  });
});

/** A small seeded source, so that a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRecords(seed: number, size: number) {
  const rand = random(seed);
  const results = ['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT', 'CANCELLED', 'DATA_INVALID'] as const;
  return Array.from({ length: size }, (_unused, index) => {
    const result = results[Math.floor(rand() * results.length)] ?? 'LOSS';
    const net = Math.round((rand() * 5 - 2.5) * 100) / 100;
    return record(result, result === 'CANCELLED' || result === 'DATA_INVALID' ? null : net, index);
  });
}

function expectClose(actual: BucketCounts, expected: BucketCounts) {
  for (const key of Object.keys(expected) as (keyof BucketCounts)[]) {
    expect(actual[key], key).toBeCloseTo(expected[key], 9);
  }
}

describe('the counts of many results', () => {
  it('keep the identities of a bucket, for any list', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const counts = countResults(randomRecords(seed, 80));
      expect(counts.n, `seed ${String(seed)}`).toBe(
        counts.wins + counts.partials + counts.losses + counts.timeExits,
      );
      expect(counts.winners).toBeLessThanOrEqual(counts.n);
      expect(counts.sumR).toBeCloseTo(counts.sumWinR + counts.sumLossR, 9);
      expect(counts.sumWinR).toBeGreaterThanOrEqual(0);
      expect(counts.sumLossR).toBeLessThanOrEqual(0);
      expect(counts.tp1Hits).toBeLessThanOrEqual(counts.n);
      expect(counts.tp2Hits).toBeLessThanOrEqual(counts.n);
    }
  });

  it('are the same whether built one result at a time or from two halves put together', () => {
    for (let seed = 100; seed < 140; seed += 1) {
      const list = randomRecords(seed, 60);
      const whole = countResults(list);
      const cut = 7 + (seed % 40);
      const halves = mergeCounts(countResults(list.slice(0, cut)), countResults(list.slice(cut)));
      expectClose(halves, whole);
      expectClose(
        mergeCounts(countResults(list.slice(cut)), countResults(list.slice(0, cut))),
        whole,
      );
    }
  });

  it('are in no way a function of the order of the results', () => {
    const list = randomRecords(7, 50);
    expectClose(countResults([...list].reverse()), countResults(list));
  });

  it('merge with nothing as the same counts', () => {
    const counts = countResults(randomRecords(3, 30));
    expect(mergeCounts(counts, EMPTY_COUNTS)).toEqual(counts);
    expect(mergeCounts(EMPTY_COUNTS, counts)).toEqual(counts);
    expect(countResults([])).toEqual(EMPTY_COUNTS);
  });

  it('take any list of results the tracker makes', () => {
    const counts = countResults(
      recordsOf([
        ['WIN', 1.5],
        ['LOSS', -1],
        ['PARTIAL_WIN', 0.5],
      ]),
    );
    expect(counts).toMatchObject({ n: 3, wins: 1, winners: 2, partials: 1, losses: 1, sumR: 1 });
    expect(T0).toBeGreaterThan(0);
  });
});
