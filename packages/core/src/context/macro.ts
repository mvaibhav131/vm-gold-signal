import type { MacroImportance, NewsState } from '../domain';
import { assertFinite } from '../indicators/types';
import { atLeast } from '../structure/types';

const MINUTE_MS = 60_000;

/** The calendar event as the engine needs it (the API's `MacroEvent` fits). `scheduledAt` is epoch milliseconds. */
export interface MacroEventInput {
  readonly id: string;
  readonly scheduledAt: number;
  readonly importance: MacroImportance;
  readonly currency: string | null;
}

/** `gates.newsWindow` of the strategy config: minutes before and after, and which events count. */
export interface NewsWindowSpec {
  readonly before: number;
  readonly after: number;
  readonly impact: readonly MacroImportance[];
  readonly currency: readonly string[];
}

/**
 * Docs/02 section 6, NEWS_WINDOW: after the scheduled window the news window stays open while the
 * spread or ATR(5m) is not yet back under 1.5 x its median. The end of that extension is not in the
 * docs: it is closed at the latest this many minutes after the event (section 5.1).
 */
export interface SettleParams {
  readonly ratio: number;
  readonly maxMinutes: number;
}

export const SETTLE_DEFAULTS: SettleParams = { ratio: 1.5, maxMinutes: 120 };

/** How far ATR(5m) and the spread are from their 24h medians, as `ratioOf` gives them. */
export interface Calm {
  readonly atrRatio: number | null;
  readonly spreadRatio: number | null;
}

export interface MacroProximity {
  /** The next matching event after now, and the minutes until it. */
  readonly next: MacroEventInput | null;
  readonly minutesToNext: number | null;
  /** The latest matching event at or before now, and the minutes since it. */
  readonly last: MacroEventInput | null;
  readonly minutesSinceLast: number | null;
  /** The scheduled window is open: now is from `before` minutes ahead of an event to `after` minutes behind it. */
  readonly inWindow: boolean;
  /** The event of that window (the one scheduled closest to now if several windows overlap). */
  readonly windowEvent: MacroEventInput | null;
  /** The window has passed, but spread or ATR are still far above normal. */
  readonly settling: boolean;
  /** The NEWS_WINDOW flag: `inWindow` or `settling`. */
  readonly windowActive: boolean;
}

/** Sorts by time, and by id when two events share a time, so that the order of the list never matters. */
function earlier(a: MacroEventInput, b: MacroEventInput): boolean {
  return a.scheduledAt === b.scheduledAt ? a.id < b.id : a.scheduledAt < b.scheduledAt;
}

/** `a` is closer to `now` than `b`; at the same distance the earlier one is. */
function nearer(a: MacroEventInput, b: MacroEventInput, now: number): boolean {
  const distanceA = Math.abs(a.scheduledAt - now);
  const distanceB = Math.abs(b.scheduledAt - now);
  return distanceA === distanceB ? earlier(a, b) : distanceA < distanceB;
}

function elevated(calm: Calm, ratio: number): boolean {
  return (
    (calm.atrRatio !== null && atLeast(calm.atrRatio, ratio)) ||
    (calm.spreadRatio !== null && atLeast(calm.spreadRatio, ratio))
  );
}

/**
 * Where `now` stands against the calendar: the next and the last event that match the window's
 * impact and currency, whether the news window is open, and whether it is still settling. Only
 * events of the listed impact and currency count; an event without a currency matches no currency.
 */
export function macroProximity(
  events: readonly MacroEventInput[],
  now: number,
  spec: NewsWindowSpec,
  calm: Calm = { atrRatio: null, spreadRatio: null },
  settle: SettleParams = SETTLE_DEFAULTS,
): MacroProximity {
  assertFinite(now, 'now');
  let next: MacroEventInput | null = null;
  let last: MacroEventInput | null = null;
  let windowEvent: MacroEventInput | null = null;
  for (const event of events) {
    if (!spec.impact.includes(event.importance)) continue;
    if (event.currency === null || !spec.currency.includes(event.currency)) continue;
    if (event.scheduledAt > now) {
      if (next === null || earlier(event, next)) next = event;
    } else if (last === null || earlier(last, event)) {
      last = event;
    }
    const open = event.scheduledAt - spec.before * MINUTE_MS;
    const close = event.scheduledAt + spec.after * MINUTE_MS;
    if (now >= open && now <= close && (windowEvent === null || nearer(event, windowEvent, now))) {
      windowEvent = event;
    }
  }

  const minutesToNext = next === null ? null : (next.scheduledAt - now) / MINUTE_MS;
  const minutesSinceLast = last === null ? null : (now - last.scheduledAt) / MINUTE_MS;
  const inWindow = windowEvent !== null;
  const settling =
    !inWindow &&
    minutesSinceLast !== null &&
    minutesSinceLast <= settle.maxMinutes &&
    elevated(calm, settle.ratio);
  return {
    next,
    minutesToNext,
    last,
    minutesSinceLast,
    inWindow,
    windowEvent,
    settling,
    windowActive: inWindow || settling,
  };
}

/** The news state of a signal: UNKNOWN when the calendar is not available (never guessed as CLEAR). */
export function newsStateOf(windowActive: boolean, calendarAvailable: boolean): NewsState {
  if (!calendarAvailable) return 'UNKNOWN';
  return windowActive ? 'IN_WINDOW' : 'CLEAR';
}
