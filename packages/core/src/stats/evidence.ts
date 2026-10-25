import type { Regime, Session, Side, StatsScope, VolBucket } from '../domain';
import type { ExplanationEvidence } from '../explain/types';
import { EMPTY_COUNTS, type BucketCounts } from './counts';
import { rateStats } from './metrics';

/** The number of levels of the bucket fallback of 02_Signal_Engine section 13: 0 is the exact bucket, 4 the widest. */
export const BUCKET_LEVELS = 5;

/** What a signal is filed under: the keys of the evidence bucket. */
export interface BucketDims {
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly side: Side;
  readonly session: Session;
  readonly regime: Regime;
  readonly volBucket: VolBucket;
}

/**
 * The bucket key at one level (`stats_bucket.bucket_key`). Each level drops a key of the one before:
 * 0 `strategy@version|side|session|regime|volatility`, 1 without the volatility, 2 without the regime,
 * 3 without the session (`strategy@version|side`), 4 without the version (`strategy|side`).
 */
export function bucketKey(level: number, dims: BucketDims): string {
  if (!Number.isInteger(level) || level < 0 || level >= BUCKET_LEVELS) {
    throw new RangeError(`a bucket level is 0 to ${String(BUCKET_LEVELS - 1)}`);
  }
  const versioned = `${dims.strategyKey}@${dims.strategyVersion}`;
  const parts = [versioned, dims.side, dims.session, dims.regime, dims.volBucket];
  return level === 4 ? `${dims.strategyKey}|${dims.side}` : parts.slice(0, 5 - level).join('|');
}

/** The five keys of a signal, from the exact bucket to the widest. */
export function bucketKeys(dims: BucketDims): string[] {
  return Array.from({ length: BUCKET_LEVELS }, (_unused, level) => bucketKey(level, dims));
}

/** The counts of the five buckets of a signal in one scope, by level; a bucket that has no row is null. */
export type ScopeBuckets = readonly (BucketCounts | null)[];

export type EvidenceBuckets = Readonly<Record<StatsScope, ScopeBuckets>>;

/** The scopes in the order they are preferred: live paper trades before the out-of-sample backtest. */
const SCOPE_ORDER: readonly StatsScope[] = ['FORWARD', 'BACKTEST_OOS'];

function countsAt(buckets: ScopeBuckets, level: number): BucketCounts {
  return buckets[level] ?? EMPTY_COUNTS;
}

function evidenceOf(scope: StatsScope, level: number, counts: BucketCounts): ExplanationEvidence {
  const stats = rateStats(counts);
  const shown = stats.winRate !== null && stats.ci95 !== null;
  return {
    scope,
    level,
    n: stats.n,
    wins: stats.winners,
    sampleLabel: stats.sampleLabel,
    winRate: shown ? stats.winRate : null,
    ci: shown ? stats.ci95 : null,
    expectancyR: shown ? stats.expectancyR : null,
    profitFactor: shown ? stats.profitFactor : null,
    tp1Rate: shown ? stats.tp1Rate : null,
    tp2Rate: shown ? stats.tp2Rate : null,
  };
}

/**
 * The evidence shown with a signal (02_Signal_Engine section 13). The exact bucket is used when it
 * has 30 resolved trades; if not, the keys are dropped one at a time (volatility, regime, session,
 * version) until a bucket has 30. Forward paper trades are preferred: the backtest is only used when
 * no level of the forward buckets reaches 30. When neither does, the evidence is "insufficient": the
 * counts of the widest forward bucket, with no percentage, interval or other figure.
 */
export function pickEvidence(buckets: EvidenceBuckets): ExplanationEvidence {
  for (const scope of SCOPE_ORDER) {
    for (let level = 0; level < BUCKET_LEVELS; level += 1) {
      const counts = countsAt(buckets[scope], level);
      if (rateStats(counts).sampleLabel !== 'INSUFFICIENT') {
        return evidenceOf(scope, level, counts);
      }
    }
  }
  return evidenceOf('FORWARD', BUCKET_LEVELS - 1, countsAt(buckets.FORWARD, BUCKET_LEVELS - 1));
}
