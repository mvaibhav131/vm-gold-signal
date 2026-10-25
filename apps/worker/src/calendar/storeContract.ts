import type { Surprise } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { T0, providerEvent } from './testData';
import type { CalendarStore } from './store';

/** What the contract tests need besides the store. */
export interface CalendarHarness {
  readonly store: CalendarStore;
  /** The surprise kept with a release. */
  readonly surprise: (id: string) => Promise<Surprise | null>;
}

const MIN = 60_000;
const DAY = 86_400_000;

/**
 * The behaviour that every `CalendarStore` must have, run against the in-memory store (unit
 * tests) and the PostgreSQL one (integration tests).
 */
export function calendarStoreContract(
  name: string,
  makeHarness: () => Promise<{ harness: CalendarHarness; done: () => Promise<void> }>,
): void {
  async function withStore(test: (harness: CalendarHarness) => Promise<void>): Promise<void> {
    const { harness, done } = await makeHarness();
    try {
      await test(harness);
    } finally {
      await done();
    }
  }

  describe(`CalendarStore (${name})`, () => {
    it('stores an event with everything the engine and the alerts read, and the time it was first seen', () =>
      withStore(async ({ store }) => {
        const result = await store.upsert([providerEvent()], T0 - DAY);
        expect(result).toEqual({ inserted: 1, updated: 0 });
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({
          sourceEventId: 'mql5:277492',
          seriesId: 'mql5:840030005',
          scheduledAt: T0,
          importance: 'high',
          currency: 'USD',
          countryCode: 'US',
          name: 'CPI m/m',
          unit: 'percent',
          multiplier: 'none',
          digits: 1,
          actual: null,
          forecast: 0.3,
          previous: 0.4,
          revisedPrevious: null,
          timeMode: 'exact',
          firstSeenAt: T0 - DAY,
          actualFirstSeenAt: null,
        });
        expect(record?.id).toEqual(expect.any(String));
      }));

    it('writes nothing for an event that did not change, and keeps the time it was first seen', () =>
      withStore(async ({ store }) => {
        await store.upsert([providerEvent()], T0 - DAY);
        expect(await store.upsert([providerEvent()], T0 - DAY + MIN)).toEqual({
          inserted: 0,
          updated: 0,
        });
        const changed = await store.upsert([providerEvent({ forecast: 0.2 })], T0 - DAY + 2 * MIN);
        expect(changed).toEqual({ inserted: 0, updated: 1 });
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({ forecast: 0.2, firstSeenAt: T0 - DAY });
      }));

    it('keeps the id of the event when it changes', () =>
      withStore(async ({ store }) => {
        await store.upsert([providerEvent()], T0 - DAY);
        const [before] = await store.between(T0, T0);
        await store.upsert([providerEvent({ scheduledAt: T0 + 5 * MIN })], T0 - DAY + MIN);
        const [after] = await store.between(T0 + 5 * MIN, T0 + 5 * MIN);
        expect(after?.id).toBe(before?.id);
        expect(await store.between(T0, T0)).toEqual([]);
      }));

    it('notes when the released value was first seen, once, and a revision does not move it', () =>
      withStore(async ({ store }) => {
        await store.upsert([providerEvent()], T0 - MIN);
        await store.upsert([providerEvent({ actual: 0.5 })], T0 + 20_000);
        await store.upsert([providerEvent({ actual: 0.6 })], T0 + 5 * MIN);
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({ actual: 0.6, actualFirstSeenAt: T0 + 20_000 });
      }));

    it('notes the time of an event that is first seen already released', () =>
      withStore(async ({ store }) => {
        await store.upsert([providerEvent({ actual: 0.5 })], T0 + 3 * DAY);
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({
          firstSeenAt: T0 + 3 * DAY,
          actualFirstSeenAt: T0 + 3 * DAY,
        });
      }));

    it('never takes back a released value that a later reading lacks, but follows the other figures', () =>
      withStore(async ({ store }) => {
        await store.upsert([providerEvent({ actual: 0.5 })], T0 + MIN);
        await store.upsert([providerEvent({ actual: null, forecast: null })], T0 + 2 * MIN);
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({ actual: 0.5, forecast: null, actualFirstSeenAt: T0 + MIN });
      }));

    it('counts several rows with one id in a batch once, the last', () =>
      withStore(async ({ store }) => {
        const result = await store.upsert(
          [providerEvent({ forecast: 0.1 }), providerEvent({ forecast: 0.2 })],
          T0 - MIN,
        );
        expect(result).toEqual({ inserted: 1, updated: 0 });
        expect((await store.between(T0, T0)).map((record) => record.forecast)).toEqual([0.2]);
      }));

    it('writes a batch of events, in one go, and an empty batch writes nothing', () =>
      withStore(async ({ store }) => {
        expect(await store.upsert([], T0)).toEqual({ inserted: 0, updated: 0 });
        const result = await store.upsert(
          [
            providerEvent({ sourceEventId: 'a', scheduledAt: T0 + 2 * MIN }),
            providerEvent({ sourceEventId: 'b', scheduledAt: T0 + MIN }),
            providerEvent({ sourceEventId: 'c', scheduledAt: T0 + 3 * MIN }),
          ],
          T0 - DAY,
        );
        expect(result).toEqual({ inserted: 3, updated: 0 });
        const again = await store.upsert(
          [
            providerEvent({ sourceEventId: 'a', scheduledAt: T0 + 2 * MIN }),
            providerEvent({ sourceEventId: 'd', scheduledAt: T0 + 4 * MIN }),
            providerEvent({ sourceEventId: 'c', scheduledAt: T0 + 3 * MIN, name: 'Core CPI m/m' }),
          ],
          T0 - DAY + MIN,
        );
        expect(again).toEqual({ inserted: 1, updated: 1 });
      }));

    it('gives the events between two times, both included, in time order', () =>
      withStore(async ({ store }) => {
        await store.upsert(
          [
            providerEvent({ sourceEventId: 'early', scheduledAt: T0 - MIN - 1 }),
            providerEvent({ sourceEventId: 'start', scheduledAt: T0 - MIN }),
            providerEvent({ sourceEventId: 'end', scheduledAt: T0 + MIN }),
            providerEvent({ sourceEventId: 'inside', scheduledAt: T0 }),
            providerEvent({ sourceEventId: 'late', scheduledAt: T0 + MIN + 1 }),
          ],
          T0 - DAY,
        );
        const found = await store.between(T0 - MIN, T0 + MIN);
        expect(found.map((record) => record.sourceEventId)).toEqual(['start', 'inside', 'end']);
      }));

    it('keeps a tentative event as tentative, and a missing detail as null', () =>
      withStore(async ({ store }) => {
        await store.upsert(
          [
            providerEvent({
              timeMode: 'tentative',
              digits: null,
              unit: null,
              multiplier: null,
              seriesId: null,
              currency: null,
              countryCode: null,
              forecast: null,
              previous: null,
            }),
          ],
          T0 - DAY,
        );
        const [record] = await store.between(T0, T0);
        expect(record).toMatchObject({
          timeMode: 'tentative',
          digits: null,
          unit: null,
          multiplier: null,
          seriesId: null,
          currency: null,
          countryCode: null,
          forecast: null,
          previous: null,
        });
      }));

    it('keeps the past releases of a series, newest first, with both figures, before a time', () =>
      withStore(async ({ store }) => {
        const series = (id: string, days: number, actual: number | null, forecast: number | null) =>
          providerEvent({
            sourceEventId: id,
            scheduledAt: T0 - days * DAY,
            actual,
            forecast,
          });
        await store.upsert(
          [
            series('p1', 30, 0.4, 0.3),
            series('p2', 60, 0.1, 0.2),
            series('p3', 90, 0.3, null),
            series('p4', 120, null, 0.3),
            series('p5', 150, 0.5, 0.5),
            providerEvent({
              sourceEventId: 'other',
              seriesId: 'mql5:other',
              actual: 1,
              forecast: 1,
              scheduledAt: T0 - 10 * DAY,
            }),
            providerEvent({ sourceEventId: 'now', actual: 0.5, forecast: 0.3 }),
          ],
          T0 - DAY,
        );
        const past = await store.archivedReleases('mql5:840030005', T0, 10);
        expect(past).toEqual([
          { sourceEventId: 'p1', actual: 0.4, forecast: 0.3 },
          { sourceEventId: 'p2', actual: 0.1, forecast: 0.2 },
          { sourceEventId: 'p5', actual: 0.5, forecast: 0.5 },
        ]);
        expect(await store.archivedReleases('mql5:840030005', T0, 2)).toHaveLength(2);
        expect(await store.archivedReleases('mql5:840030005', T0 - 60 * DAY, 10)).toEqual([
          { sourceEventId: 'p5', actual: 0.5, forecast: 0.5 },
        ]);
        expect(await store.archivedReleases('mql5:840030005', T0 - 60 * DAY + 1, 10)).toEqual([
          { sourceEventId: 'p2', actual: 0.1, forecast: 0.2 },
          { sourceEventId: 'p5', actual: 0.5, forecast: 0.5 },
        ]);
        expect(await store.archivedReleases('mql5:unknown', T0, 10)).toEqual([]);
      }));

    it('keeps the surprise of a release, and an update of the event does not lose it', () =>
      withStore(async ({ store, surprise }) => {
        await store.upsert([providerEvent({ actual: 0.5 })], T0 + MIN);
        const [record] = await store.between(T0, T0);
        expect(await surprise(record?.id ?? '')).toBeNull();
        await store.saveSurprise(record?.id ?? '', { sigma: 2.14, n: 8, std: 0.093 });
        await store.upsert([providerEvent({ actual: 0.6 })], T0 + 2 * MIN);
        expect(await surprise(record?.id ?? '')).toEqual({ sigma: 2.14, n: 8, std: 0.093 });
      }));

    it('knows when the calendar was last read well, and that it never was', () =>
      withStore(async ({ store }) => {
        expect(await store.lastOk()).toBeNull();
        await store.recordOk(T0, { events: 3 });
        expect(await store.lastOk()).toBe(T0);
        await store.recordOk(T0 + MIN, { events: 4 });
        expect(await store.lastOk()).toBe(T0 + MIN);
      }));
  });
}
