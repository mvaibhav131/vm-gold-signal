import type { PeriodRow, StoredEngine, TimeWindow } from '@vmgs/core';

import type { BotStore, OpenSignalRow, StatusFacts } from '../telegram/botStore';
import type { PendingLink } from '../telegram/link';

/** The facts of the bot in memory: a test sets what the replies are made of and reads what the bot wrote. */
export class MemoryBotStore implements BotStore {
  chat: number | null = null;
  pending: PendingLink | null = null;
  state: StoredEngine = { status: 'RUNNING' };
  facts: StatusFacts = {
    nextHigh: null,
    calendarAvailable: true,
    openStatuses: [],
    regime: null,
    waitReasons: [],
    strategies: [],
  };
  openRows: OpenSignalRow[] = [];
  latestQuote: { bid: number; ask: number } | null = null;
  closedTexts: string[] = [];
  rows: PeriodRow[] = [];
  /** The windows `periodRows` was asked for, in order. */
  readonly windows: TimeWindow[] = [];
  /** The `maxAgeMs` that `quote` was asked with, in order. */
  readonly quoteAges: number[] = [];
  /** The next calls of `linkedChat` throw (a database that is down). */
  failLinkedChat = 0;

  linkedChat(): Promise<number | null> {
    if (this.failLinkedChat > 0) {
      this.failLinkedChat -= 1;
      return Promise.reject(new Error('the database is down'));
    }
    return Promise.resolve(this.chat);
  }

  pendingLink(): Promise<PendingLink | null> {
    return Promise.resolve(this.pending);
  }

  setPendingLink(link: PendingLink | null): Promise<void> {
    this.pending = link;
    return Promise.resolve();
  }

  linkChat(chatId: number): Promise<void> {
    this.chat = chatId;
    this.pending = null;
    return Promise.resolve();
  }

  engine(): Promise<StoredEngine> {
    return Promise.resolve(this.state);
  }

  saveEngine(state: StoredEngine): Promise<void> {
    this.state = state;
    return Promise.resolve();
  }

  status(): Promise<StatusFacts> {
    return Promise.resolve(this.facts);
  }

  open(): Promise<OpenSignalRow[]> {
    return Promise.resolve([...this.openRows]);
  }

  quote(_now: number, maxAgeMs: number): Promise<{ bid: number; ask: number } | null> {
    this.quoteAges.push(maxAgeMs);
    return Promise.resolve(this.latestQuote);
  }

  lastClosedTexts(): Promise<string[]> {
    return Promise.resolve([...this.closedTexts]);
  }

  periodRows(window: TimeWindow): Promise<PeriodRow[]> {
    this.windows.push(window);
    return Promise.resolve([...this.rows]);
  }
}
