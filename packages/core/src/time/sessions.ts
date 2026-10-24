import type { Session } from '../domain';
import { type CivilDate, utcCivilDate, zonedParts, zonedWallTimeToUtc } from './zone';

const DAY_MS = 86_400_000;

const ASIA_END_SEC = 8 * 3600;
const ROLLOVER_START_SEC = (21 * 60 + 45) * 60;
const ROLLOVER_END_SEC = (23 * 60 + 15) * 60;

interface Venue {
  readonly zone: string;
  readonly openMinute: number;
  readonly closeMinute: number;
}

/** 08:00-16:30 London time and 08:00-17:00 New York time, Monday to Friday (bank holidays are not modelled). */
const LONDON: Venue = { zone: 'Europe/London', openMinute: 8 * 60, closeMinute: 16 * 60 + 30 };
const NEW_YORK: Venue = { zone: 'America/New_York', openMinute: 8 * 60, closeMinute: 17 * 60 };

function isOpen(ms: number, venue: Venue): boolean {
  const p = zonedParts(ms, venue.zone);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const seconds = p.hour * 3600 + p.minute * 60 + p.second;
  return seconds >= venue.openMinute * 60 && seconds < venue.closeMinute * 60;
}

/**
 * The trading session at an instant (02_Signal_Engine section 2), first match wins:
 *
 * 1. ROLLOVER: 21:45-23:15 UTC.
 * 2. OVERLAP: London and New York are both open. LONDON or NEW_YORK: only one of them is open.
 *    London wins over ASIA in the hour in summer when both definitions apply (07:00-08:00 UTC).
 * 3. ASIA: 00:00-08:00 UTC.
 * 4. Anything else has no regular session (the quiet gaps between New York's close and 00:00 UTC,
 *    and weekends) and is also ROLLOVER: thin liquidity, advisory only.
 *
 * The label only matters while the market is open; the feed state says when it is closed.
 */
export function sessionAt(ms: number): Session {
  const secondOfDay = ((Math.floor(ms / 1000) % 86_400) + 86_400) % 86_400;
  if (secondOfDay >= ROLLOVER_START_SEC && secondOfDay < ROLLOVER_END_SEC) return 'ROLLOVER';
  const london = isOpen(ms, LONDON);
  const newYork = isOpen(ms, NEW_YORK);
  if (london && newYork) return 'OVERLAP';
  if (london) return 'LONDON';
  if (newYork) return 'NEW_YORK';
  return secondOfDay < ASIA_END_SEC ? 'ASIA' : 'ROLLOVER';
}

export interface SessionSegment {
  readonly session: Session;
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

function venueEdge(date: CivilDate, venue: Venue, minute: number): number {
  return zonedWallTimeToUtc(date, Math.floor(minute / 60), minute % 60, venue.zone);
}

/** The sessions of one UTC day as contiguous segments that cover it exactly. `dayStartMs` is 00:00 UTC. */
export function sessionSegments(dayStartMs: number): SessionSegment[] {
  if (dayStartMs % DAY_MS !== 0) throw new RangeError('dayStartMs must be 00:00 UTC');
  const date = utcCivilDate(dayStartMs);
  const dayEndMs = dayStartMs + DAY_MS;
  const cuts = new Set<number>([
    dayStartMs,
    dayStartMs + ASIA_END_SEC * 1000,
    dayStartMs + ROLLOVER_START_SEC * 1000,
    dayStartMs + ROLLOVER_END_SEC * 1000,
    dayEndMs,
  ]);
  for (const venue of [LONDON, NEW_YORK]) {
    cuts.add(venueEdge(date, venue, venue.openMinute));
    cuts.add(venueEdge(date, venue, venue.closeMinute));
  }
  const sorted = [...cuts]
    .filter((cut) => cut >= dayStartMs && cut <= dayEndMs)
    .sort((a, b) => a - b);
  const segments: SessionSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const startMs = sorted[i];
    const endMs = sorted[i + 1];
    if (startMs === undefined || endMs === undefined) continue;
    const session = sessionAt(startMs);
    const last = segments.at(-1);
    if (last?.session === session) segments[segments.length - 1] = { ...last, endMs };
    else segments.push({ session, startMs, endMs });
  }
  return segments;
}

/** The session containing `ms` with its start and end. Sessions never span 00:00 UTC (ASIA always starts there). */
export function sessionWindowAt(ms: number): SessionSegment {
  const dayStartMs = Math.floor(ms / DAY_MS) * DAY_MS;
  const found = sessionSegments(dayStartMs).find((s) => ms >= s.startMs && ms < s.endMs);
  if (!found) throw new Error(`no session segment covers ${String(ms)}`);
  return found;
}

/** A venue that is open: when its day opened and closes, and how far `ms` is from each. */
export interface VenueClock {
  readonly openMs: number;
  readonly closeMs: number;
  readonly minutesSinceOpen: number;
  readonly minutesToClose: number;
}

/**
 * `ms` against the opening hours of a venue, or null when it is closed. A venue never opens or
 * closes across a daylight-saving change (they happen at the weekend), so the day's open and close
 * are found by counting back and forward from the local time of day.
 */
function venueClockAt(ms: number, venue: Venue): VenueClock | null {
  if (!isOpen(ms, venue)) return null;
  const p = zonedParts(ms, venue.zone);
  const secondOfDay = p.hour * 3600 + p.minute * 60 + p.second;
  const wholeSecondMs = Math.floor(ms / 1000) * 1000;
  const openMs = wholeSecondMs - (secondOfDay - venue.openMinute * 60) * 1000;
  const closeMs = openMs + (venue.closeMinute - venue.openMinute) * 60_000;
  return {
    openMs,
    closeMs,
    minutesSinceOpen: (ms - openMs) / 60_000,
    minutesToClose: (closeMs - ms) / 60_000,
  };
}

export interface SessionClock {
  readonly session: Session;
  /** The stretch of time that carries this label: from `startMs` (included) to `endMs` (excluded). */
  readonly startMs: number;
  readonly endMs: number;
  readonly minutesSinceStart: number;
  readonly minutesToEnd: number;
  /**
   * The opening hours of London and New York, null while closed. The label's own end is not the
   * close of a market (LONDON ends when New York opens, OVERLAP when London closes), so a rule about
   * "the last minutes of a session" reads these.
   */
  readonly london: VenueClock | null;
  readonly newYork: VenueClock | null;
}

/** The session label at an instant with the minutes since it started and until it ends, and the open venues. */
export function sessionClockAt(ms: number): SessionClock {
  const window = sessionWindowAt(ms);
  return {
    session: window.session,
    startMs: window.startMs,
    endMs: window.endMs,
    minutesSinceStart: (ms - window.startMs) / 60_000,
    minutesToEnd: (window.endMs - ms) / 60_000,
    london: venueClockAt(ms, LONDON),
    newYork: venueClockAt(ms, NEW_YORK),
  };
}
