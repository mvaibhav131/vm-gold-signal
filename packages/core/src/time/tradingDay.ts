import {
  type CivilDate,
  addCivilDays,
  formatCivilDate,
  zonedParts,
  zonedWallTimeToUtc,
} from './zone';

/** The trading day rolls at 17:00 New York time (02_Signal_Engine section 2), DST aware. */
export const TRADING_DAY_ZONE = 'America/New_York';
export const TRADING_DAY_ROLL_HOUR = 17;

export interface TradingDay {
  /** First instant of the day: 17:00 New York on the previous calendar date. */
  readonly startMs: number;
  /** First instant of the next day (exclusive end). */
  readonly endMs: number;
  /**
   * FX convention: the day is named after the New York date on which it ends, so the session that
   * opens Sunday 17:00 is Monday's trading day.
   */
  readonly label: string;
}

/**
 * The trading day containing `ms`. Its length is 24 h, except on the two days a year when New
 * York changes its clocks (23 h or 25 h); those fall on the weekend, when gold is closed.
 */
export function tradingDayOf(ms: number): TradingDay {
  const now = zonedParts(ms, TRADING_DAY_ZONE);
  const startDate: CivilDate = addCivilDays(now, now.hour < TRADING_DAY_ROLL_HOUR ? -1 : 0);
  const endDate = addCivilDays(startDate, 1);
  return {
    startMs: zonedWallTimeToUtc(startDate, TRADING_DAY_ROLL_HOUR, 0, TRADING_DAY_ZONE),
    endMs: zonedWallTimeToUtc(endDate, TRADING_DAY_ROLL_HOUR, 0, TRADING_DAY_ZONE),
    label: formatCivilDate(endDate),
  };
}

/**
 * The first Saturday 12:00 New York strictly after `afterMs`. A gap in the data that contains this
 * instant spans a whole weekend closure (Friday 17:00 to Sunday 17:00), so it is expected.
 */
export function nextWeekendMidpoint(afterMs: number): number {
  const now = zonedParts(afterMs, TRADING_DAY_ZONE);
  const daysToSaturday = (6 - now.weekday + 7) % 7;
  const candidate = zonedWallTimeToUtc(addCivilDays(now, daysToSaturday), 12, 0, TRADING_DAY_ZONE);
  if (candidate > afterMs) return candidate;
  return zonedWallTimeToUtc(addCivilDays(now, daysToSaturday + 7), 12, 0, TRADING_DAY_ZONE);
}
