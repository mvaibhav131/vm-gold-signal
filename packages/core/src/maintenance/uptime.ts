import { DAY_MS } from './retention';
import { TRADING_DAY_ROLL_HOUR, TRADING_DAY_ZONE } from '../time/tradingDay';
import { addCivilDays, zonedParts, zonedWallTimeToUtc } from '../time/zone';

/**
 * The time in [from, until) in which the market is open: all of it less the weekly closure (Friday 17:00 to Sunday
 * 17:00 New York time, the fallback schedule of `isWeekendClosure`). A feed that is silent while the market is shut is
 * not an outage, so the uptime of a feed is measured over this time.
 */
export function tradingMsBetween(from: number, until: number): number {
  if (!(until > from)) return 0;
  // a closure is two days long, so the first Friday that can matter is within three days before `from`
  const start = zonedParts(from - 3 * DAY_MS, TRADING_DAY_ZONE);
  let friday = addCivilDays(
    { year: start.year, month: start.month, day: start.day },
    (5 - start.weekday + 7) % 7,
  );
  let closed = 0;
  for (;;) {
    const opens = zonedWallTimeToUtc(friday, TRADING_DAY_ROLL_HOUR, 0, TRADING_DAY_ZONE);
    if (opens >= until) break;
    const reopens = zonedWallTimeToUtc(
      addCivilDays(friday, 2),
      TRADING_DAY_ROLL_HOUR,
      0,
      TRADING_DAY_ZONE,
    );
    closed += Math.max(0, Math.min(reopens, until) - Math.max(opens, from));
    friday = addCivilDays(friday, 7);
  }
  return until - from - closed;
}

/** An incident of the feed (`feed_incidents`): it goes on while `endedAt` is null. */
export interface IncidentSpan {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * How the feed did in [from, until): the incidents that touch it, and the share of the market's open time in which none
 * was going on (overlapping incidents are one silence, an open incident lasts to `until`). Null when the market was
 * not open at all in the window.
 */
export function feedUptime(
  spans: readonly IncidentSpan[],
  from: number,
  until: number,
): { readonly incidents: number; readonly uptime: number | null } {
  const touching = spans
    .map((span) => ({
      from: Math.max(span.startedAt, from),
      until: Math.min(span.endedAt ?? until, until),
    }))
    .filter((span) => span.until > span.from);
  const incidents = spans.filter(
    (span) => span.startedAt < until && (span.endedAt === null || span.endedAt > from),
  ).length;

  const merged: { from: number; until: number }[] = [];
  for (const span of [...touching].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.until)
      last.until = Math.max(last.until, span.until);
    else merged.push({ ...span });
  }
  const total = tradingMsBetween(from, until);
  if (!(total > 0)) return { incidents, uptime: null };
  const down = merged.reduce((sum, span) => sum + tradingMsBetween(span.from, span.until), 0);
  return { incidents, uptime: Math.max(0, 1 - down / total) };
}
