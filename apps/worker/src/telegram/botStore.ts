import type {
  OpenFacts,
  PeriodRow,
  StatusData,
  StoredEngine,
  StrategyKey,
  StrategyStatus,
  TimeWindow,
} from '@vmgs/core';

import type { PendingLink } from './link';

/** An open signal as `/open` needs it. */
export interface OpenSignalRow extends OpenFacts {
  readonly seq: number;
  readonly strategyKey: StrategyKey;
  /** The stop in force: the stop-loss, or the entry after TP1. */
  readonly stop: number;
  readonly tp2: number | null;
  readonly timeStopAt: number;
}

export interface StatusFacts {
  readonly nextHigh: StatusData['nextHigh'];
  /** The calendar was read recently; otherwise `nextHigh` says nothing. */
  readonly calendarAvailable: boolean;
  readonly openStatuses: readonly ('ACTIVE' | 'TP1_HIT')[];
  readonly strategies: readonly {
    readonly key: StrategyKey;
    readonly version: string;
    readonly status: StrategyStatus;
  }[];
}

/**
 * What the bot reads and writes besides the outbox: the link to the owner's chat, the owner's pause,
 * and the facts that the replies are made of. The messages themselves are made in `packages/core`.
 */
export interface BotStore {
  /** The chat id of the owner; null until `/link` has worked. */
  linkedChat(): Promise<number | null>;
  pendingLink(): Promise<PendingLink | null>;
  /** Keeps the state of a code after a try; null forgets it. */
  setPendingLink(link: PendingLink | null): Promise<void>;
  /** Stores the owner's chat and forgets the code, as one step. */
  linkChat(chatId: number, at: number): Promise<void>;
  engine(): Promise<StoredEngine>;
  saveEngine(state: StoredEngine, at: number): Promise<void>;
  status(now: number): Promise<StatusFacts>;
  open(): Promise<OpenSignalRow[]>;
  /** The latest quote no older than `maxAgeMs`, or null. */
  quote(now: number, maxAgeMs: number): Promise<{ bid: number; ask: number } | null>;
  /** The Telegram texts of the latest signal that has a result, oldest first; empty if there is none. */
  lastClosedTexts(): Promise<string[]>;
  /** Signals generated in the window (not backtests), with their result when they have one. */
  periodRows(window: TimeWindow): Promise<PeriodRow[]>;
}
