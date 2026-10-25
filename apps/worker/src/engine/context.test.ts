import { describe, expect, it } from 'vitest';

import { providerEvent } from '../calendar/testData';
import { MemoryCalendarStore } from '../testing/memoryCalendarStore';
import { calendarContextOf } from './context';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const HOUR = 3_600_000;

async function rig() {
  const store = new MemoryCalendarStore();
  await store.upsert(
    [
      providerEvent({ sourceEventId: 'a', scheduledAt: NOW + 30 * 60_000, name: 'CPI m/m' }),
      providerEvent({ sourceEventId: 'b', scheduledAt: NOW - 2 * HOUR, name: 'Retail sales m/m' }),
      providerEvent({ sourceEventId: 'far-ahead', scheduledAt: NOW + 9 * HOUR }),
      providerEvent({ sourceEventId: 'far-behind', scheduledAt: NOW - 4 * HOUR }),
    ],
    NOW - 10 * HOUR,
  );
  return { store, read: calendarContextOf(store) };
}

describe('calendarContextOf', () => {
  it('has the events from three hours behind to eight hours ahead, with their names', async () => {
    const { store, read } = await rig();
    await store.recordOk(NOW - 60_000);
    const context = await read(NOW);
    expect(context.events.map((event) => event.scheduledAt)).toEqual([
      NOW - 2 * HOUR,
      NOW + 30 * 60_000,
    ]);
    expect(context.events[0]).toMatchObject({
      scheduledAt: NOW - 2 * HOUR,
      importance: 'high',
      currency: 'USD',
    });
    expect(Object.keys(context.events[0] ?? {}).sort()).toEqual([
      'currency',
      'id',
      'importance',
      'scheduledAt',
    ]);
    expect(Object.values(context.names).sort()).toEqual(['CPI m/m', 'Retail sales m/m']);
    expect(Object.keys(context.names).sort()).toEqual(
      context.events.map((event) => event.id).sort(),
    );
  });

  it('asks the calendar for exactly three hours behind and eight hours ahead', async () => {
    const { store, read } = await rig();
    const asked: [number, number][] = [];
    const between = store.between.bind(store);
    store.between = (from, to) => {
      asked.push([from, to]);
      return between(from, to);
    };
    await read(NOW);
    expect(asked).toEqual([[NOW - 3 * HOUR, NOW + 8 * HOUR]]);
  });

  it('can be trusted while the last good reading is at most 15 minutes old, and not after', async () => {
    const { store, read } = await rig();
    await store.recordOk(NOW - 15 * 60_000);
    expect((await read(NOW)).available).toBe(true);
    expect((await read(NOW + 1)).available).toBe(false);
  });

  it('cannot be trusted when it was never read', async () => {
    const { read } = await rig();
    expect((await read(NOW)).available).toBe(false);
  });

  it('lets a failing store fail the decision look, which keeps the candle for the next one', async () => {
    const { store, read } = await rig();
    store.failure = new Error('the database is down');
    await expect(read(NOW)).rejects.toThrow('the database is down');
  });
});
