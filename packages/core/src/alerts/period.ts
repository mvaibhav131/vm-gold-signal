import { addCivilDays, zonedParts, zonedWallTimeToUtc } from '../time/zone';

/** A half-open span of time in epoch milliseconds: `from` is in, `until` is out. */
export interface TimeWindow {
  readonly from: number;
  readonly until: number;
}

/** The calendar day of the display time zone that holds `now` (`/today`). */
export function dayWindow(now: number, timeZone: string): TimeWindow {
  const { year, month, day } = zonedParts(now, timeZone);
  const date = { year, month, day };
  return {
    from: zonedWallTimeToUtc(date, 0, 0, timeZone),
    until: zonedWallTimeToUtc(addCivilDays(date, 1), 0, 0, timeZone),
  };
}

/** The calendar month of the display time zone that holds `now` (`/month`). */
export function monthWindow(now: number, timeZone: string): TimeWindow {
  const { year, month } = zonedParts(now, timeZone);
  return {
    from: zonedWallTimeToUtc({ year, month, day: 1 }, 0, 0, timeZone),
    until: zonedWallTimeToUtc(
      month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 },
      0,
      0,
      timeZone,
    ),
  };
}
