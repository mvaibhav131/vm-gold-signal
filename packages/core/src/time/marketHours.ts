import { addCivilDays, zonedParts, zonedWallTimeToUtc } from './zone';

/** The gold market (spot XAU/USD) closes for an hour at 17:00 New York time on weekdays, and at the weekend from Friday 17:00. */
const MARKET_ZONE = 'America/New_York';
const CLOSE_HOUR = 17;

/**
 * The next close of the market after `ms`: 17:00 New York time on a Monday to Friday (22:00 UTC in winter, 21:00 UTC in summer,
 * as the clocks of New York change). The close of a Friday starts the weekend. The feed was seen to stop in the minute before it.
 */
export function nextMarketClose(ms: number): number {
  const now = zonedParts(ms, MARKET_ZONE);
  const today = { year: now.year, month: now.month, day: now.day };
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addCivilDays(today, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const close = zonedWallTimeToUtc(date, CLOSE_HOUR, 0, MARKET_ZONE);
    if (close > ms) return close;
  }
  throw new Error(`no market close found after ${String(ms)}`);
}

/**
 * The start of the trading day of `ms`: the last close of the market (17:00 New York time on a weekday) at or before it. A day
 * of results is counted from here, so the hours after the daily break and the Sunday opening belong to the day that follows
 * the close, not to the calendar day of any zone.
 */
export function tradingDayStart(ms: number): number {
  const now = zonedParts(ms, MARKET_ZONE);
  const today = { year: now.year, month: now.month, day: now.day };
  for (let offset = 0; offset >= -7; offset -= 1) {
    const date = addCivilDays(today, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const close = zonedWallTimeToUtc(date, CLOSE_HOUR, 0, MARKET_ZONE);
    if (close <= ms) return close;
  }
  throw new Error(`no market close found before ${String(ms)}`);
}
