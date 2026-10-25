import { calendarAvailable } from '@vmgs/core';

import type { CalendarStore } from '../calendar/store';
import type { CalendarContext } from './loop';

/** How far back and ahead the decision looks at the calendar: the last event still settling, and the next one that the news score and the flags use. */
const BEHIND_MS = 3 * 3_600_000;
const AHEAD_MS = 8 * 3_600_000;

/**
 * The calendar as the decision loop needs it: the events around now with their names, and whether the calendar feed can be
 * trusted (its last good reading is recent). When it cannot, the news state is `UNKNOWN`, never `CLEAR`.
 */
export function calendarContextOf(
  store: Pick<CalendarStore, 'between' | 'lastOk'>,
): (now: number) => Promise<CalendarContext> {
  return async (now) => {
    const [events, lastOk] = await Promise.all([
      store.between(now - BEHIND_MS, now + AHEAD_MS),
      store.lastOk(),
    ]);
    return {
      available: calendarAvailable(lastOk, now),
      events: events.map(({ id, scheduledAt, importance, currency }) => ({
        id,
        scheduledAt,
        importance,
        currency,
      })),
      names: Object.fromEntries(events.map((event) => [event.id, event.name])),
    };
  };
}
