import {
  DecisionEngine,
  ENGINE_TIMEFRAMES,
  TIMEFRAME_MS,
  engineStateOf,
  mergeByClose,
  type BucketDims,
  type DecisionContext,
  type EngineTimeframe,
  type ExplanationEvidence,
  type FeedFacts,
  type MacroEventInput,
  type StrategySpec,
  type StructureBreakSeen,
  type ExplanationHeadline,
  type Regime,
  type ReviewedTrade,
} from '@vmgs/core';

import type { CreateSignalResult } from '../lifecycle/types';
import type { CandleCursor, EngineStore, StoredCandle } from './store';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

/** The calendar as the decision needs it: whether it can be trusted, the events around now and their names. */
export interface CalendarContext {
  readonly available: boolean;
  readonly events: readonly MacroEventInput[];
  readonly names: Readonly<Record<string, string>>;
}

export interface NewsContextPort {
  read(at: number): Promise<{
    readonly feed: 'AVAILABLE' | 'UNAVAILABLE';
    readonly headlines: ExplanationHeadline[];
    readonly lastHighHeadlineAt: number | null;
  }>;
}

/** What the live feed says about itself now: the numbers of the data gates. */
export interface FeedView {
  readonly facts: FeedFacts;
  readonly clockSkewMs: number | null;
}

export interface DecisionLoopOptions {
  readonly specs: readonly StrategySpec[];
  readonly store: EngineStore;
  readonly creator: { create(input: unknown): Promise<CreateSignalResult> };
  readonly calendar: (now: number) => Promise<CalendarContext>;
  readonly news: NewsContextPort;
  readonly feed: () => FeedView;
  /** Called after signals were written, so that the sender picks up their alerts. */
  readonly onQueued?: () => void;
  readonly now?: () => number;
  /** How often the loop looks at the table when it was not woken. */
  readonly pollMs?: number;
  /** How many candles of each timeframe are replayed at the start. */
  readonly history?: Readonly<Record<EngineTimeframe, number>>;
  readonly log?: Log;
}

/** The warm-up of the gates plus room for the indicators to settle: a 5m candle is 3 days, a 15m one 15 days, a 1h one 25 days of market time. */
export const DEFAULT_HISTORY: Readonly<Record<EngineTimeframe, number>> = {
  '5m': 1_500,
  '15m': 2_000,
  '1h': 900,
};

/** A candle closed more than this long ago is history, not a decision: the entry is valid for 3 minutes. */
const DECISION_WINDOW_MS = 5 * 60_000;
const BATCH = 2_000;

const keyOf = (dims: BucketDims): string => JSON.stringify(dims);

/**
 * The loop that turns the candles of the database into signals (01_HLD section 5, steps 1 to 4). It owns the
 * `DecisionEngine`: at the start it replays the stored candles (the warm-up), then it follows the table. When a 5m
 * candle has closed and its confirming quote is stored, it makes one decision: a signal for every setup that passed
 * every gate (through the signal transaction), a `rejections` row for every setup that did not, and the engine state
 * for `/status` and the dashboard. While the owner has paused the engine it keeps the candles and the state but
 * writes no signal. Everything it knows comes from the database, so a restart rebuilds the same engine.
 */
export class DecisionLoop {
  private readonly options: DecisionLoopOptions;
  private readonly engine: DecisionEngine;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log: Log;
  private readonly cursor: Record<EngineTimeframe, number | null> = {
    '5m': null,
    '15m': null,
    '1h': null,
  };
  /** The newest 5m candle that has closed and has not been decided yet. */
  private pending: { readonly openTime: number; readonly closeTime: number } | null = null;
  private decidedOpenTime: number | null = null;
  private warmed = false;
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private woken = false;
  private readonly counters = {
    decisions: 0,
    signals: 0,
    rejections: 0,
    duplicates: 0,
    skipped: 0,
  };

  constructor(options: DecisionLoopOptions) {
    this.options = options;
    this.engine = new DecisionEngine(options.specs);
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 5_000;
    this.log = options.log ?? (() => undefined);
  }

  get counts(): Readonly<Record<EngineTimeframe, number>> {
    return this.engine.counts;
  }

  /** How many decisions were made and what came of them. */
  get stats(): Readonly<
    Record<'decisions' | 'signals' | 'rejections' | 'duplicates' | 'skipped', number>
  > {
    return { ...this.counters };
  }

  /** The regime at a past close and the 15m and 1h changes of character, for the review of a trade (`ContextSource`). */
  contextOf(
    trade: Pick<ReviewedTrade, 'fillAt'>,
    closedAt: number,
  ): { regimeAtClose: Regime | null; structureBreaks: StructureBreakSeen[] } {
    return {
      regimeAtClose: this.engine.regimeAt(closedAt),
      structureBreaks: this.engine.changesOfCharacter(trade.fillAt, closedAt),
    };
  }

  /** Replays the stored candles into the engine, in the order they closed, without deciding anything. */
  async warmUp(): Promise<void> {
    const stored = await this.options.store.history(this.options.history ?? DEFAULT_HISTORY);
    this.feed(stored, false);
    this.warmed = true;
    this.log('info', 'the decision engine is warmed up', { ...this.engine.counts });
  }

  private feed(stored: readonly StoredCandle[], decide: boolean): void {
    const series: Record<EngineTimeframe, StoredCandle['candle'][]> = {
      '5m': [],
      '15m': [],
      '1h': [],
    };
    for (const item of stored) series[item.tf].push(item.candle);
    for (const step of mergeByClose(series)) {
      this.engine.push(step.tf, step.candle);
      this.cursor[step.tf] = step.candle.openTime;
      if (decide && step.tf === '5m') {
        // only the newest 5m candle can be decided: the engine answers for it alone
        this.pending =
          this.now() - step.closeTime <= DECISION_WINDOW_MS
            ? { openTime: step.candle.openTime, closeTime: step.closeTime }
            : null;
      }
    }
  }

  /** One look at the table: feeds the new candles and, when a 5m candle has just closed, decides. Returns how many signals it wrote. */
  async runOnce(): Promise<number> {
    if (!this.warmed) await this.warmUp();
    for (;;) {
      const cursor: CandleCursor = { ...this.cursor };
      const more = await this.options.store.after(cursor, BATCH);
      this.feed(more, true);
      if (more.length < BATCH) break;
    }
    return this.decidePending();
  }

  private async decidePending(): Promise<number> {
    const pending = this.pending;
    if (pending === null || this.decidedOpenTime === pending.openTime) return 0;
    const { store } = this.options;
    const now = this.now();
    const quote = await store.firstQuoteAtOrAfter(pending.closeTime);
    if (quote === null) {
      if (now - pending.closeTime > DECISION_WINDOW_MS) {
        this.pending = null;
        this.counters.skipped += 1;
        this.log('error', 'no quote after the close of a 5m candle: no decision', {
          closedAt: new Date(pending.closeTime).toISOString(),
        });
      }
      return 0;
    }

    const entryValidMs =
      Math.min(...this.options.specs.map((spec) => spec.risk.entryValidSec)) * 1000;
    if (quote.t - pending.closeTime > entryValidMs) {
      this.decidedOpenTime = pending.openTime;
      this.pending = null;
      this.counters.skipped += 1;
      this.log('error', 'the first quote came too late for an entry: no decision', {
        lateMs: quote.t - pending.closeTime,
      });
      return 0;
    }

    // What is read from the database before the decision may fail: the candle then stays pending and is tried again.
    const [controls, calendar, news, open] = await Promise.all([
      store.controls(now),
      this.options.calendar(now),
      this.options.news.read(now),
      store.openSignals(),
    ]);
    const feed = this.options.feed();
    const evidence = new Map<string, ExplanationEvidence>();
    for (const candidate of this.engine.candidates()) {
      evidence.set(keyOf(candidate.dims), await store.evidence(candidate.dims));
    }
    const context: DecisionContext = {
      mode: 'LIVE',
      quote: { t: quote.t, bid: quote.bid, ask: quote.ask },
      feed: feed.facts,
      clockSkewMs: feed.clockSkewMs,
      dataLatencyMs: Math.max(0, now - quote.t),
      calendar: { available: calendar.available, events: calendar.events, names: calendar.names },
      news,
      open: open.map(({ id, side, riskR }) => ({ id, side, riskR })),
      modes: controls.modes,
      openLabels: Object.fromEntries(open.map((item) => [item.id, item.label])),
    };
    const decision = this.engine.decide(context, (dims) => {
      const found = evidence.get(keyOf(dims));
      if (found === undefined) throw new Error('no evidence was loaded for a candidate');
      return found;
    });
    if (decision === null) return 0;
    this.decidedOpenTime = pending.openTime;
    this.pending = null;
    this.counters.decisions += 1;

    const first = this.options.specs[0];
    if (first !== undefined) {
      const required = [...new Set(this.options.specs.flatMap((spec) => spec.requiredTimeframes))];
      try {
        await store.saveState(
          engineStateOf(decision.report, required, first.gates.warmupCandles),
          now,
        );
      } catch (error) {
        // the state is for the screens: a signal is not held back because it could not be saved
        this.log('error', 'the engine state could not be saved', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (controls.paused) return 0;

    let written = 0;
    for (const outcome of decision.outcomes) {
      try {
        if (outcome.kind === 'SIGNAL') {
          const result = await this.options.creator.create(outcome.draft);
          if (result.status === 'CREATED') {
            written += 1;
            this.counters.signals += 1;
          } else {
            this.counters.duplicates += 1;
          }
        } else {
          await store.recordRejection(decision.report.decidedAt, outcome.rejection);
          this.counters.rejections += 1;
        }
      } catch (error) {
        this.log('error', 'a decision could not be written', {
          strategy: outcome.candidate.spec.strategyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (written > 0) this.options.onQueued?.();
    return written;
  }

  /** Tells the loop that the recorder has stored something: it looks at the table now instead of at the next poll. */
  wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.log('error', 'the decision loop could not finish a look', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.stopped()) break;
      if (!this.woken) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollMs);
          this.wakeUp = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      this.wakeUp = null;
      this.woken = false;
    }
  }

  /** `stop()` may be called while a look is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}

export { ENGINE_TIMEFRAMES, TIMEFRAME_MS };
