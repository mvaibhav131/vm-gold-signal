import { describe, expect, it } from 'vitest';

import {
  BUCKET_LEVELS,
  bucketKey,
  bucketKeys,
  pickEvidence,
  type BucketDims,
  type EvidenceBuckets,
  type ScopeBuckets,
} from './evidence';
import { EMPTY_COUNTS } from './counts';
import { rateStats } from './metrics';
import { bucket } from './test-data';
import { wilson } from './wilson';

const DIMS: BucketDims = {
  strategyKey: 'trend_pullback',
  strategyVersion: '0.1.0',
  side: 'BUY',
  session: 'LONDON',
  regime: 'TREND_UP',
  volBucket: 'NORMAL',
};

describe('the bucket keys', () => {
  it('drop one key at each level, from the exact bucket to the widest', () => {
    expect(bucketKeys(DIMS)).toEqual([
      'trend_pullback@0.1.0|BUY|LONDON|TREND_UP|NORMAL',
      'trend_pullback@0.1.0|BUY|LONDON|TREND_UP',
      'trend_pullback@0.1.0|BUY|LONDON',
      'trend_pullback@0.1.0|BUY',
      'trend_pullback|BUY',
    ]);
    expect(BUCKET_LEVELS).toBe(5);
  });

  it('give one key of a level', () => {
    for (let level = 0; level < BUCKET_LEVELS; level += 1) {
      expect(bucketKey(level, DIMS)).toBe(bucketKeys(DIMS)[level]);
    }
  });

  it('keep the two sides, the versions and the other keys apart', () => {
    const keys = (dims: BucketDims) => bucketKeys(dims);
    expect(keys({ ...DIMS, side: 'SELL' }).every((key, i) => key !== keys(DIMS)[i])).toBe(true);
    // a new version has its own buckets, except at the widest level
    const next = keys({ ...DIMS, strategyVersion: '0.2.0' });
    expect(next.slice(0, 4).every((key, i) => key !== keys(DIMS)[i])).toBe(true);
    expect(next[4]).toBe(keys(DIMS)[4]);
    // another session changes the buckets down to the one with no session
    const asia = keys({ ...DIMS, session: 'ASIA' });
    expect(asia[0]).not.toBe(keys(DIMS)[0]);
    expect(asia[1]).not.toBe(keys(DIMS)[1]);
    expect(asia[2]).not.toBe(keys(DIMS)[2]);
    expect(asia[3]).toBe(keys(DIMS)[3]);
    // another volatility only changes the exact bucket
    const high = keys({ ...DIMS, volBucket: 'HIGH' });
    expect(high[0]).not.toBe(keys(DIMS)[0]);
    expect(high.slice(1)).toEqual(keys(DIMS).slice(1));
  });

  it('refuse a level that does not exist', () => {
    for (const level of [-1, 5, 1.5, Number.NaN]) {
      expect(() => bucketKey(level, DIMS), String(level)).toThrow(RangeError);
    }
  });
});

const none: ScopeBuckets = [null, null, null, null, null];
const scope = (...counts: (ReturnType<typeof bucket> | null)[]): ScopeBuckets => [
  ...counts,
  ...Array<null>(BUCKET_LEVELS - counts.length).fill(null),
];
const buckets = (forward: ScopeBuckets, backtest: ScopeBuckets = none): EvidenceBuckets => ({
  FORWARD: forward,
  BACKTEST_OOS: backtest,
});

describe('pickEvidence: the exact bucket when it has 30 trades', () => {
  it('uses level 0 at exactly 30 resolved trades', () => {
    const evidence = pickEvidence(buckets(scope(bucket(15, 15), bucket(40, 40))));
    expect(evidence).toMatchObject({ scope: 'FORWARD', level: 0, n: 30, wins: 15 });
    expect(evidence.sampleLabel).toBe('LOW_SAMPLE');
  });

  it('shows the figures of that bucket, with the Wilson interval', () => {
    const evidence = pickEvidence(buckets(scope(bucket(37, 27))));
    expect(evidence).toEqual({
      scope: 'FORWARD',
      level: 0,
      n: 64,
      wins: 37,
      sampleLabel: 'LOW_SAMPLE',
      winRate: 0.578,
      ci: wilson(37, 64),
      expectancyR: rateStats(bucket(37, 27)).expectancyR,
      profitFactor: rateStats(bucket(37, 27)).profitFactor,
      tp1Rate: 0.578,
      tp2Rate: 0.578,
    });
  });

  it('is a normal sample from 100 trades', () => {
    expect(pickEvidence(buckets(scope(bucket(60, 40)))).sampleLabel).toBe('NORMAL');
  });
});

describe('pickEvidence: it falls back one level at a time', () => {
  it('uses the first level that has 30 trades', () => {
    const forward = scope(
      bucket(5, 5),
      bucket(8, 7),
      bucket(10, 10),
      bucket(30, 30),
      bucket(80, 80),
    );
    expect(pickEvidence(buckets(forward))).toMatchObject({ level: 3, n: 60, wins: 30 });
  });

  it('tries 29 before 30 at every level', () => {
    for (let level = 0; level < BUCKET_LEVELS; level += 1) {
      const small = Array.from({ length: BUCKET_LEVELS }, (_unused, i) =>
        i < level ? bucket(14, 15) : i === level ? bucket(15, 15) : bucket(50, 50),
      );
      expect(pickEvidence(buckets(small)).level, `level ${String(level)}`).toBe(level);
    }
  });

  it('skips a level that has no row at all', () => {
    const forward: ScopeBuckets = [null, null, bucket(20, 15), null, bucket(60, 60)];
    expect(pickEvidence(buckets(forward))).toMatchObject({ level: 2, n: 35 });
  });

  it('uses the widest level when only that one is big enough', () => {
    const forward = scope(bucket(1, 2), bucket(2, 3), bucket(3, 3), bucket(5, 5), bucket(30, 20));
    expect(pickEvidence(buckets(forward))).toMatchObject({ level: 4, n: 50, wins: 30 });
  });
});

describe('pickEvidence: forward trades are preferred to the backtest', () => {
  it('takes a wide forward bucket before an exact backtest bucket', () => {
    const forward = scope(bucket(2, 2), null, null, null, bucket(20, 15));
    const backtest = scope(bucket(150, 90));
    expect(pickEvidence(buckets(forward, backtest))).toMatchObject({
      scope: 'FORWARD',
      level: 4,
      n: 35,
    });
  });

  it('turns to the backtest only when no forward level has 30 trades', () => {
    const forward = scope(bucket(2, 2), bucket(4, 4), bucket(6, 6), bucket(8, 8), bucket(10, 10));
    const backtest = scope(bucket(5, 5), bucket(25, 25));
    expect(pickEvidence(buckets(forward, backtest))).toMatchObject({
      scope: 'BACKTEST_OOS',
      level: 1,
      n: 50,
    });
  });

  it('falls back inside the backtest in the same way', () => {
    const backtest = scope(null, null, null, bucket(15, 15), bucket(100, 100));
    expect(pickEvidence(buckets(none, backtest))).toMatchObject({
      scope: 'BACKTEST_OOS',
      level: 3,
      n: 30,
    });
  });

  it('shows the backtest as its own scope and never mixes the two', () => {
    const evidence = pickEvidence(buckets(none, scope(bucket(60, 40))));
    expect(evidence.scope).toBe('BACKTEST_OOS');
    expect(evidence.n).toBe(100);
  });
});

describe('pickEvidence: without 30 trades anywhere the evidence is insufficient', () => {
  it('has the counts of the widest forward bucket and no figure', () => {
    const forward = scope(bucket(1, 1), bucket(2, 2), bucket(3, 3), bucket(4, 4), bucket(7, 5));
    const backtest = scope(bucket(10, 10), bucket(12, 12));
    expect(pickEvidence(buckets(forward, backtest))).toEqual({
      scope: 'FORWARD',
      level: 4,
      n: 12,
      wins: 7,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
      ci: null,
      expectancyR: null,
      profitFactor: null,
      tp1Rate: null,
      tp2Rate: null,
    });
  });

  it('has zero counts when nothing has been recorded', () => {
    expect(pickEvidence(buckets(none))).toMatchObject({
      scope: 'FORWARD',
      level: 4,
      n: 0,
      wins: 0,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
    });
    expect(pickEvidence(buckets([], []))).toMatchObject({ n: 0, level: 4 });
    expect(pickEvidence(buckets(scope(EMPTY_COUNTS)))).toMatchObject({ n: 0 });
  });

  it('counts a win rate at 29 trades as not enough, and does not show its expectancy either', () => {
    const evidence = pickEvidence(
      buckets(scope(bucket(29, 0), bucket(29, 0), bucket(29, 0), bucket(29, 0), bucket(29, 0))),
    );
    expect(evidence).toMatchObject({
      n: 29,
      sampleLabel: 'INSUFFICIENT',
      expectancyR: null,
      profitFactor: null,
    });
  });
});
