import type { CalendarRecord, Surprise, TickPoint } from '@vmgs/core';

import type { ProviderEvent } from '../calendar/provider';
import type {
  ArchivedRelease,
  CalendarStore,
  TickWindowReader,
  UpsertResult,
} from '../calendar/store';

interface Stored {
  record: CalendarRecord;
  event: ProviderEvent;
}

/** The calendar in memory, with the same rules as the PostgreSQL store (the contract tests run against both). */
export class MemoryCalendarStore implements CalendarStore, TickWindowReader {
  readonly surprises = new Map<string, Surprise>();
  /** Ticks that a test puts in for `ticks()`. */
  tickList: TickPoint[] = [];
  /** A failure that the next call of every method throws, until cleared. */
  failure: Error | null = null;
  readonly calls = { upsert: 0, between: 0, archived: 0 };
  private readonly events = new Map<string, Stored>();
  private okAt: number | null = null;
  private sequence = 0;

  upsert(events: readonly ProviderEvent[], now: number): Promise<UpsertResult> {
    this.calls.upsert += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    const latest = new Map(events.map((event) => [event.sourceEventId, event]));
    let inserted = 0;
    let updated = 0;
    for (const event of latest.values()) {
      const old = this.events.get(event.sourceEventId);
      if (old === undefined) {
        this.sequence += 1;
        this.events.set(event.sourceEventId, {
          event,
          record: recordOf(
            `ev-${String(this.sequence)}`,
            event,
            now,
            event.actual === null ? null : now,
          ),
        });
        inserted += 1;
        continue;
      }
      const actual = event.actual ?? old.event.actual;
      const merged: ProviderEvent = { ...event, actual };
      if (sameEvent(old.event, merged)) continue;
      this.events.set(event.sourceEventId, {
        event: merged,
        record: recordOf(
          old.record.id,
          merged,
          old.record.firstSeenAt,
          old.record.actualFirstSeenAt ?? (actual === null ? null : now),
        ),
      });
      updated += 1;
    }
    return Promise.resolve({ inserted, updated });
  }

  between(from: number, until: number): Promise<CalendarRecord[]> {
    this.calls.between += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      [...this.events.values()]
        .map((stored) => stored.record)
        .filter((record) => record.scheduledAt >= from && record.scheduledAt <= until)
        .sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id)),
    );
  }

  archivedReleases(seriesId: string, before: number, limit: number): Promise<ArchivedRelease[]> {
    this.calls.archived += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      [...this.events.values()]
        .map((stored) => stored.record)
        .filter(
          (record) =>
            record.seriesId === seriesId &&
            record.scheduledAt < before &&
            record.actual !== null &&
            record.forecast !== null,
        )
        .sort((a, b) => b.scheduledAt - a.scheduledAt)
        .slice(0, limit)
        .map(({ sourceEventId, actual, forecast }) => ({ sourceEventId, actual, forecast })),
    );
  }

  saveSurprise(id: string, surprise: Surprise): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.surprises.set(id, surprise);
    return Promise.resolve();
  }

  recordOk(at: number): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.okAt = at;
    return Promise.resolve();
  }

  lastOk(): Promise<number | null> {
    return Promise.resolve(this.okAt);
  }

  ticks(from: number, until: number): Promise<TickPoint[]> {
    return Promise.resolve(
      this.tickList
        .filter((tick) => tick.ts >= from && tick.ts <= until)
        .sort((a, b) => a.ts - b.ts),
    );
  }

  /** Every event, for a test. */
  all(): CalendarRecord[] {
    return [...this.events.values()].map((stored) => stored.record);
  }
}

function recordOf(
  id: string,
  event: ProviderEvent,
  firstSeenAt: number,
  actualFirstSeenAt: number | null,
): CalendarRecord {
  return {
    id,
    sourceEventId: event.sourceEventId,
    seriesId: event.seriesId,
    scheduledAt: event.scheduledAt,
    importance: event.importance,
    currency: event.currency,
    countryCode: event.countryCode,
    name: event.name,
    unit: event.unit,
    multiplier: event.multiplier,
    digits: event.digits,
    actual: event.actual,
    forecast: event.forecast,
    previous: event.previous,
    revisedPrevious: event.revisedPrevious,
    timeMode: event.timeMode,
    firstSeenAt,
    actualFirstSeenAt,
  };
}

const sameEvent = (a: ProviderEvent, b: ProviderEvent): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
