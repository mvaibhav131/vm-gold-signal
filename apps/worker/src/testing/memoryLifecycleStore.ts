import { randomUUID } from 'node:crypto';

import { defaultSettings, strategyConfigHash, type StrategyConfig } from '@vmgs/config';
import type { SignalDraft } from '@vmgs/contracts';
import {
  type AfterCandle,
  type AlertSettings,
  type CauseCode,
  type CourseCandle,
  type HighImpactSeen,
  type LedgerTrade,
  type OutboxChannel,
  type OutboxRow,
  type RollupSignal,
  type Side,
  type SignalMode,
  type TickInput,
  type TradeOutcome,
  type TradeState,
  COURSE_CANDLE_MS,
  RollupTables,
  TRADED_SYMBOL,
  causeChangeDelta,
  closedDelta,
  createdDelta,
  repairRollups,
} from '@vmgs/core';

import { spreadOfSnapshot } from '../lifecycle/record';
import { rollupSignalOf } from '../rollups/facts';
import type { RollupStore, RollupTx } from '../rollups/reconcile';
import type {
  CreateSignalResult,
  CreatedSignal,
  FinalReviewWrite,
  LifecycleStore,
  LifecycleWrite,
  LogEvent,
  MarketReader,
  PendingReview,
  SignalRecord,
  StoredReview,
  StrategyVersionRef,
} from '../lifecycle/types';

interface StoredEvent {
  readonly signalId: string;
  readonly event: LogEvent;
}

interface StoredOutcome {
  readonly outcome: TradeOutcome;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface StoredOutbox extends OutboxRow {
  readonly status: 'PENDING';
}

/**
 * The lifecycle store in memory, with the semantics of the Postgres one: a setup makes one signal,
 * an event type is written once, closing is all or nothing, and a signal is open while it has a
 * working state. Unit tests use it; the Postgres store is held to the same contract by the shared
 * store tests.
 */
export class MemoryLifecycleStore implements LifecycleStore, MarketReader, RollupStore {
  readonly strategies = new Map<string, { ref: StrategyVersionRef; config: StrategyConfig }>();
  readonly signals = new Map<string, SignalRecord>();
  readonly states = new Map<string, TradeState>();
  readonly events: StoredEvent[] = [];
  readonly outcomes = new Map<string, StoredOutcome>();
  readonly outbox = new Map<string, StoredOutbox>();
  readonly autopsies = new Map<string, StoredReview>();
  readonly notifications: { readonly signalId: string; readonly change: string }[] = [];
  /** The FORWARD rollup tables, written as the Postgres store writes them. */
  rollups = new RollupTables();
  /** The keys each signal is filed under in the rollups, and its mode. */
  private readonly filed = new Map<string, { mode: SignalMode; signal: RollupSignal }>();
  settings: AlertSettings = defaultAlertSettings();
  ticks: TickInput[] = [];
  candles: CourseCandle[] = [];
  highImpactItems: HighImpactSeen[] = [];
  /** Makes the next `commit` fail, to test what a failed write leaves behind. */
  failNextCommit = false;
  private seq = 0;
  readonly commits: LifecycleWrite[] = [];

  ensureStrategyVersion(config: StrategyConfig): Promise<StrategyVersionRef> {
    const key = `${config.strategyKey}@${config.version}`;
    const hash = strategyConfigHash(config);
    const existing = this.strategies.get(key);
    if (existing !== undefined) {
      if (strategyConfigHash(existing.config) !== hash) {
        return Promise.reject(
          new Error(`strategy version ${key} exists with another config: change the version`),
        );
      }
      return Promise.resolve(existing.ref);
    }
    const ref: StrategyVersionRef = {
      id: randomUUID(),
      strategyKey: config.strategyKey,
      version: config.version,
      status: 'RESEARCH',
    };
    this.strategies.set(key, { ref, config });
    return Promise.resolve(ref);
  }

  loadSettings(): Promise<AlertSettings> {
    return Promise.resolve(this.settings);
  }

  createSignal(
    draft: SignalDraft,
    strategy: StrategyVersionRef,
    outbox: (created: CreatedSignal) => readonly OutboxRow[],
    now: number,
  ): Promise<CreateSignalResult> {
    try {
      return Promise.resolve(this.insertSignal(draft, strategy, outbox, now));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private insertSignal(
    draft: SignalDraft,
    strategy: StrategyVersionRef,
    outbox: (created: CreatedSignal) => readonly OutboxRow[],
    now: number,
  ): CreateSignalResult {
    const entry = [...this.strategies.values()].find((item) => item.ref.id === strategy.id);
    if (entry === undefined) throw new Error('unknown strategy version');
    const duplicate = [...this.signals.values()].some(
      (record) =>
        record.strategy.id === strategy.id &&
        record.side === draft.side &&
        this.setupKeys.get(record.id) === draft.setupKey,
    );
    if (duplicate) return { status: 'DUPLICATE' };

    this.seq += 1;
    const created: CreatedSignal = { id: randomUUID(), seq: this.seq, createdAt: now };
    const rows = outbox(created);
    const told: OutboxChannel[] = rows
      .filter((row) => row.kind === 'SIGNAL_NEW')
      .map((row) => row.channel);
    const record: SignalRecord = {
      id: created.id,
      seq: created.seq,
      createdAt: created.createdAt,
      strategy: entry.ref,
      side: draft.side,
      mode: draft.mode,
      exitProfile: draft.exitProfile,
      generatedAt: Date.parse(draft.generatedAt),
      sourceAt: Date.parse(draft.sourceAt),
      entry: draft.entry,
      maxValidEntry: draft.maxValidEntry,
      entryValidUntil: Date.parse(draft.entryValidUntil),
      stopLoss: draft.stopLoss,
      tp1: draft.tp1,
      tp2: draft.tp2,
      riskDistance: draft.riskDistance,
      atr5: draft.atr5,
      timeStopAt: Date.parse(draft.timeStopAt),
      regime: draft.regime,
      groups: draft.groupedScores.map(({ key, state }) => ({ key, state })),
      spreadAtEntry: spreadOfSnapshot(draft.featureSnapshot),
      explanation: draft.explanation,
      simSlippageUsd: entry.config.risk.simSlippageUsd,
      commissionUsdPerOz: entry.config.risk.commissionUsdPerOz,
      maxTickAgeSec: entry.config.gates.maxTickAgeSec,
      told,
    };
    this.signals.set(record.id, record);
    this.setupKeys.set(record.id, draft.setupKey);
    const signal = rollupSignalOf(draft, strategy);
    this.filed.set(record.id, { mode: draft.mode, signal });
    if (draft.mode === 'LIVE') this.rollups.apply(createdDelta(signal));
    this.states.set(record.id, {
      status: 'ACTIVE',
      stopLossCurrent: draft.stopLoss,
      tp1HitAt: null,
      mfeR: 0,
      maeR: 0,
    });
    this.addEvent(record.id, { type: 'CREATED', at: record.generatedAt, price: record.entry });
    this.addOutbox(rows);
    if (rows.length > 0) this.addEvent(record.id, { type: 'ALERT_QUEUED', at: now, price: null });
    this.notifications.push({ signalId: record.id, change: 'created' });
    return { status: 'CREATED', created };
  }

  private readonly setupKeys = new Map<string, string>();

  loadOpenSignals(): Promise<SignalRecord[]> {
    const open = [...this.signals.values()]
      .filter((record) => this.states.has(record.id))
      .sort((a, b) => a.seq - b.seq)
      .map((record) => this.withTold(record));
    return Promise.resolve(open);
  }

  getSignal(id: string): Promise<SignalRecord | null> {
    const record = this.signals.get(id);
    return Promise.resolve(record === undefined ? null : this.withTold(record));
  }

  commit(write: LifecycleWrite): Promise<boolean> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return Promise.reject(new Error('the database is not available'));
    }
    this.commits.push(write);
    const { signalId } = write;
    if (this.outcomes.has(signalId) || !this.signals.has(signalId)) return Promise.resolve(false);
    for (const event of write.events) this.addEvent(signalId, event);
    if (write.closing !== null) {
      this.outcomes.set(signalId, {
        outcome: write.closing.outcome,
        meta: write.closing.meta,
      });
      this.states.delete(signalId);
      if (write.closing.review !== null) {
        this.autopsies.set(signalId, write.closing.review);
        this.addEvent(signalId, {
          type: 'AUTOPSY_PRELIMINARY',
          at: write.closing.review.computedAt,
          price: null,
        });
      }
      const filed = this.filed.get(signalId);
      if (filed?.mode === 'LIVE') {
        this.rollups.apply(
          closedDelta({
            ...filed.signal,
            outcome: write.closing.outcome,
            primaryCause: write.closing.review?.review.primaryCause ?? null,
          }),
        );
      }
      this.notifications.push({ signalId, change: 'closed' });
    } else if (write.state !== null) {
      this.states.set(signalId, write.state);
      if (write.events.length > 0) this.notifications.push({ signalId, change: 'state' });
    }
    this.addOutbox(write.outbox);
    return Promise.resolve(true);
  }

  commitFinalReview(write: FinalReviewWrite): Promise<boolean> {
    const stored = this.autopsies.get(write.signalId);
    if (stored?.review.status !== 'PRELIMINARY') return Promise.resolve(false);
    const filed = this.filed.get(write.signalId);
    const outcome = this.outcomes.get(write.signalId)?.outcome;
    if (filed?.mode === 'LIVE') {
      this.rollups.apply(
        causeChangeDelta(
          { ...filed.signal, netR: outcome?.realizedRNet ?? 0 },
          stored.review.primaryCause,
          write.review.primaryCause,
        ),
      );
    }
    this.autopsies.set(write.signalId, {
      review: write.review,
      computedAt: stored.computedAt,
      finalizedAt: write.finalizedAt,
    });
    this.addEvent(write.signalId, {
      type: 'AUTOPSY_FINAL',
      at: write.finalizedAt,
      price: null,
    });
    this.addOutbox(write.outbox);
    this.notifications.push({ signalId: write.signalId, change: 'review' });
    return Promise.resolve(true);
  }

  causeCount(month: string, cause: CauseCode): Promise<number> {
    return Promise.resolve(
      this.rollups
        .snapshot()
        .causes.filter((row) => row.month === month && row.causeCode === cause)
        .reduce((sum, row) => sum + row.n, 0),
    );
  }

  loadPendingReviews(closedBefore: number): Promise<PendingReview[]> {
    const pending: PendingReview[] = [];
    for (const [signalId, stored] of this.autopsies) {
      const outcome = this.outcomes.get(signalId)?.outcome;
      const record = this.signals.get(signalId);
      if (stored.review.status !== 'PRELIMINARY') continue;
      if (outcome === undefined || record === undefined || outcome.closedAt > closedBefore)
        continue;
      pending.push({ record: this.withTold(record), outcome, preliminary: stored.review });
    }
    return Promise.resolve(pending.sort((a, b) => a.record.seq - b.record.seq));
  }

  *readTicks(from: number, until: number): Iterable<TickInput> {
    const inRange = this.ticks
      .filter((tick) => tick.symbol === TRADED_SYMBOL && tick.ts >= from && tick.ts < until)
      .map((tick, index) => ({ tick, index }))
      .sort((a, b) => a.tick.rxAt - b.tick.rxAt || a.tick.ts - b.tick.ts || a.index - b.index);
    for (const { tick } of inRange) yield tick;
  }

  closingSideCandles(side: Side, from: number, until: number): Promise<AfterCandle[]> {
    const buckets = new Map<number, AfterCandle>();
    for (const tick of this.readTicks(from, until)) {
      const price = side === 'BUY' ? tick.bid : tick.ask;
      const openTime = Math.floor(tick.ts / COURSE_CANDLE_MS) * COURSE_CANDLE_MS;
      const seen = buckets.get(openTime);
      buckets.set(
        openTime,
        seen === undefined
          ? { openTime, high: price, low: price }
          : { openTime, high: Math.max(seen.high, price), low: Math.min(seen.low, price) },
      );
    }
    return Promise.resolve([...buckets.values()].sort((a, b) => a.openTime - b.openTime));
  }

  lastCandles5m(until: number, limit: number): Promise<CourseCandle[]> {
    const eligible = this.candles
      .filter((candle) => candle.openTime <= until)
      .sort((a, b) => a.openTime - b.openTime);
    return Promise.resolve(eligible.slice(Math.max(0, eligible.length - limit)));
  }

  highImpact(from: number, until: number): Promise<HighImpactSeen[]> {
    return Promise.resolve(
      this.highImpactItems
        .filter((item) => item.at >= from && item.at <= until)
        .sort((a, b) => a.at - b.at),
    );
  }

  /** The signals as the reconciliation reads them: every LIVE one, open or closed, in the order they were made. */
  ledger(): LedgerTrade[] {
    return [...this.signals.values()]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((record) => {
        const filed = this.filed.get(record.id);
        if (filed?.mode !== 'LIVE') return [];
        const outcome = this.outcomes.get(record.id)?.outcome ?? null;
        return [
          {
            ...filed.signal,
            outcome,
            primaryCause: this.autopsies.get(record.id)?.review.primaryCause ?? null,
          },
        ];
      });
  }

  withLock<T>(work: (tx: RollupTx) => Promise<T>): Promise<T> {
    return work({
      stored: () => Promise.resolve(this.rollups.snapshot()),
      ledger: () => Promise.resolve(this.ledger()),
      replace: (differences) => {
        this.rollups = new RollupTables().apply(
          repairRollups(this.rollups.snapshot(), differences),
        );
        return Promise.resolve();
      },
    });
  }

  /** The signal log of one signal; `ALERT_QUEUED` (bookkeeping about the messages) only with `withAlerts`. */
  eventsOf(signalId: string, withAlerts = false): LogEvent[] {
    return this.events
      .filter((item) => item.signalId === signalId)
      .map((item) => item.event)
      .filter((event) => withAlerts || event.type !== 'ALERT_QUEUED');
  }

  private withTold(record: SignalRecord): SignalRecord {
    const key = `signal:${record.id}:confirmed`;
    const told = [...this.outbox.values()]
      .filter((row) => row.eventKey === key)
      .map((row) => row.channel)
      .sort();
    return { ...record, told };
  }

  private addEvent(signalId: string, event: LogEvent): void {
    if (this.events.some((item) => item.signalId === signalId && item.event.type === event.type)) {
      return;
    }
    this.events.push({ signalId, event });
  }

  private addOutbox(rows: readonly OutboxRow[]): void {
    for (const row of rows) {
      const key = `${row.eventKey}|${row.channel}`;
      if (!this.outbox.has(key)) this.outbox.set(key, { ...row, status: 'PENDING' });
    }
  }
}

export function defaultAlertSettings(): AlertSettings {
  const settings = defaultSettings();
  return {
    displayTz: settings.displayTz,
    locale: settings.locale,
    alerts: settings.alerts,
    strategyAlerts: settings.strategyAlerts,
    newsAlerts: settings.newsAlerts,
  };
}
