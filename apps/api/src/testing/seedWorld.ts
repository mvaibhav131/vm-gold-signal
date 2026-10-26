import { defaultStrategyConfig } from '@vmgs/config';
import type { SignalDraft } from '@vmgs/contracts';
import type { Review, StrategyKey, TradeOutcome, TradeState } from '@vmgs/core';
import { qualityGrade } from '@vmgs/core';
import { createPool } from '@vmgs/db';
import type { Pool } from 'pg';

import { query } from '../../../../packages/db/test/database';
import { signalDraft } from '../../../../packages/contracts/src/test-fixtures';
import { PostgresLifecycleStore } from '../../../worker/src/lifecycle/postgresStore';
import type { PgApi } from './pgApi';

/** 2026-10-23 06:10:00 UTC, the close of a 5m candle and the time of the example signal of the docs. */
export const SEED_AT = Date.UTC(2026, 9, 23, 6, 10, 0);
export const MINUTE_MS = 60_000;

export interface SeededSignal {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface SeedSignalOptions {
  readonly strategy?: StrategyKey;
  readonly side?: 'BUY' | 'SELL';
  readonly generatedAt?: number;
  readonly setupKey?: string;
  /** The quality score (65 and up); the explanation is kept in step with it, as the contract wants. */
  readonly qualityScore?: number;
  readonly draft?: Partial<SignalDraft>;
}

/**
 * What the worker writes, written by the worker's own store: the API tests read signals, states, outcomes, reviews and
 * rollups that are exactly what the lifecycle makes (the signal transaction, the closing, the notifications on
 * `vmgs_signals`), not a copy of their columns. The store runs as the role `vmgs_worker`, with its real rights.
 */
export class SeedWorld {
  private counter = 0;

  constructor(
    readonly store: PostgresLifecycleStore,
    /** The pool of the role `vmgs_worker`: for the other stores of the worker (the engine's controls, ...). */
    readonly pool: Pool,
    private readonly end: () => Promise<void>,
  ) {}

  /** A signal as the decision loop creates it: the draft is the example of the docs, moved to the options. */
  async createSignal(options: SeedSignalOptions = {}): Promise<SeededSignal> {
    const strategyKey = options.strategy ?? 'trend_pullback';
    const config = defaultStrategyConfig(strategyKey);
    const version = await this.store.ensureStrategyVersion(config);
    const generatedAt = options.generatedAt ?? SEED_AT;
    const side = options.side ?? 'BUY';
    const base = signalDraft();
    const sell: Partial<SignalDraft> =
      side === 'SELL'
        ? { side, maxValidEntry: 4017.19, stopLoss: 4023.84, tp1: 4010.9, tp2: 4004.43 }
        : {};
    const levels =
      side === 'SELL'
        ? {
            entry: 4017.37,
            maxValidEntry: 4017.19,
            stop: 4023.84,
            tp1: 4010.9,
            tp2: 4004.43,
            riskUsd: 6.47,
          }
        : base.explanation.levels;
    const score = options.qualityScore ?? base.qualityScore;
    this.counter += 1;
    const draft: SignalDraft = {
      ...base,
      featureSnapshot: { ema20: 4015.2, rsi14: 54.1, spread: 0.12 },
      ...sell,
      qualityScore: score,
      explanation: {
        ...base.explanation,
        headline: `${side} XAUUSD - ${strategyKey} v${config.version}`,
        levels,
        quality: { score, grade: qualityGrade(score) ?? 'Moderate' },
      },
      strategyKey,
      strategyVersion: config.version,
      generatedAt: new Date(generatedAt).toISOString(),
      sourceAt: new Date(generatedAt).toISOString(),
      entryValidUntil: new Date(generatedAt + 3 * MINUTE_MS).toISOString(),
      timeStopAt: new Date(generatedAt + 120 * MINUTE_MS).toISOString(),
      setupKey: options.setupKey ?? `${strategyKey}:${String(this.counter)}:${String(generatedAt)}`,
      ...options.draft,
    };
    const result = await this.store.createSignal(draft, version, () => [], generatedAt + 400);
    if (result.status !== 'CREATED') throw new Error('the seeded signal was a duplicate');
    return result.created;
  }

  /** Moves the working state of an open signal (the tracker's write), e.g. after TP1. */
  async setState(signalId: string, state: TradeState, at: number): Promise<void> {
    await this.store.commit({ signalId, events: [], state, closing: null, outbox: [], at });
  }

  /** Closes a signal with an outcome and, when given, its preliminary review. */
  async close(
    signal: SeededSignal,
    outcome: TradeOutcome,
    review: Review | null = null,
  ): Promise<void> {
    const closed = await this.store.commit({
      signalId: signal.id,
      events: [],
      state: null,
      closing: {
        outcome,
        meta: {},
        review:
          review === null ? null : { review, computedAt: outcome.closedAt, finalizedAt: null },
      },
      outbox: [],
      at: outcome.closedAt,
    });
    if (!closed) throw new Error('the signal was closed already');
  }

  async finish(): Promise<void> {
    await this.end();
  }
}

/** An outcome that closed at `closedAt`; the fields a test does not care about are the usual ones of that result. */
export function outcomeOf(
  result: 'WIN' | 'LOSS' | 'PARTIAL_WIN' | 'TIME_EXIT' | 'CANCELLED' | 'DATA_INVALID',
  closedAt: number,
  overrides: Partial<TradeOutcome> = {},
): TradeOutcome {
  const base = {
    closedAt,
    costR: 0,
    ambiguous: false,
    durationS: Math.max(0, Math.floor((closedAt - SEED_AT) / 1000)),
  };
  switch (result) {
    case 'WIN':
      return {
        ...base,
        result,
        countsInStats: true,
        exitPrice: 4030.31,
        exitReason: 'TP2',
        realizedRGross: 1.5,
        realizedRNet: 1.47,
        mfeR: 2.1,
        maeR: -0.4,
        tp1Hit: true,
        tp2Hit: true,
        isWin: true,
        ...overrides,
      };
    case 'PARTIAL_WIN':
      return {
        ...base,
        result,
        countsInStats: true,
        exitPrice: 4020,
        exitReason: 'STOP_AT_ENTRY',
        realizedRGross: 0.5,
        realizedRNet: 0.47,
        mfeR: 1.1,
        maeR: -0.3,
        tp1Hit: true,
        tp2Hit: false,
        isWin: true,
        ...overrides,
      };
    case 'LOSS':
      return {
        ...base,
        result,
        countsInStats: true,
        exitPrice: 4010.9,
        exitReason: 'STOP',
        realizedRGross: -1,
        realizedRNet: -1.03,
        mfeR: 0.2,
        maeR: -1,
        tp1Hit: false,
        tp2Hit: false,
        isWin: false,
        ...overrides,
      };
    case 'TIME_EXIT':
      return {
        ...base,
        result,
        countsInStats: true,
        exitPrice: 4018,
        exitReason: 'TIME_STOP',
        realizedRGross: 0.1,
        realizedRNet: 0.07,
        mfeR: 0.4,
        maeR: -0.2,
        tp1Hit: false,
        tp2Hit: false,
        isWin: false,
        ...overrides,
      };
    case 'CANCELLED':
      return {
        ...base,
        result,
        countsInStats: false,
        exitPrice: null,
        exitReason: 'STALE_BEFORE_ENTRY',
        realizedRGross: null,
        realizedRNet: null,
        mfeR: null,
        maeR: null,
        durationS: 0,
        tp1Hit: false,
        tp2Hit: false,
        isWin: false,
        ...overrides,
      };
    case 'DATA_INVALID':
      return {
        ...base,
        result,
        countsInStats: false,
        exitPrice: null,
        exitReason: 'DATA_GAP',
        realizedRGross: null,
        realizedRNet: null,
        mfeR: null,
        maeR: null,
        tp1Hit: false,
        tp2Hit: false,
        isWin: false,
        ...overrides,
      };
  }
}

/** The worker's store on the database of `api`, with the rights of the role `vmgs_worker`. */
export async function startSeedWorld(api: PgApi): Promise<SeedWorld> {
  await query(api.database.url, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  const pool = createPool(api.database.urlFor('vmgs_worker', 'worker-pass'), { max: 4 });
  return new SeedWorld(new PostgresLifecycleStore(pool), pool, () => pool.end());
}
