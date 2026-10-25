import {
  systemChannels,
  systemMessage,
  systemOutboxRows,
  type SystemMessage,
} from '../alerts/system';
import { ALERT_WORDS } from '../alerts/words';
import type { MacroImportance, NewsImpact } from '../domain';
import { priceText, signedPriceText, spanText } from '../explain/format';
import { displayOptionsOf, type AlertSettings, type OutboxRow } from '../lifecycle/alerts';
import { bold, clean } from '../messages/markup';
import { ICON } from '../messages/style';
import { clockText } from '../messages/time';
import type { DisplayOptions } from '../messages/types';
import { sigmaText, valueText, type ValueUnits } from './format';
import { importanceAtLeast, type CalendarRecord } from './types';

// The two messages about the calendar (04_API_and_Notifications section 4.1): an event that is
// coming, and an event that was released.

/** NEWS_UPCOMING goes out this long before the event. */
export const UPCOMING_LEAD_MS = 30 * 60_000;
/** NEWS_RELEASED is worth sending for this long after the released value was first seen. */
export const RELEASED_TTL_MS = 30 * 60_000;
/** The release message tells where gold was this many seconds after the scheduled time ... */
export const GOLD_AFTER_S = 15;
/** ... and so it waits until that second is stored. */
export const GOLD_AFTER_READY_MS = 20_000;

export type CalendarStep = 'upcoming' | 'released';

/** The outbox key of a message about an event: `news:<id>:upcoming` and `news:<id>:released` (04, section 6). */
export const calendarEventKey = (id: string, step: CalendarStep): string => `news:${id}:${step}`;

const IMPORTANCE_OF: Readonly<Record<NewsImpact, MacroImportance>> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

/** Which events are told about: of these currencies and at least this impact. */
export interface CalendarPolicy {
  readonly currencies: readonly string[];
  readonly minImpact: NewsImpact;
}

/** An event that is told about and watched closely: of these currencies and at least this impact. */
export function policyCounts(
  event: Pick<CalendarRecord, 'importance' | 'currency'>,
  policy: CalendarPolicy,
): boolean {
  return (
    event.currency !== null &&
    policy.currencies.includes(event.currency) &&
    importanceAtLeast(event.importance, IMPORTANCE_OF[policy.minImpact])
  );
}

const byTime = (a: CalendarRecord, b: CalendarRecord): number =>
  a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id);

/**
 * Events that are within `UPCOMING_LEAD_MS` ahead and not yet past. Only an event with an exact
 * time can be counted down to: a tentative one, or one with only a date, is not announced.
 */
export function upcomingDue(
  events: readonly CalendarRecord[],
  now: number,
  policy: CalendarPolicy,
): CalendarRecord[] {
  return events
    .filter(
      (event) =>
        policyCounts(event, policy) &&
        event.timeMode === 'exact' &&
        event.scheduledAt > now &&
        event.scheduledAt - now <= UPCOMING_LEAD_MS,
    )
    .sort(byTime);
}

/**
 * Events whose released value came in the last `RELEASED_TTL_MS`, once the second at which gold is
 * measured is stored. An event with only a date has no time to measure from. A value that was first
 * seen long after its time (a backfill, or a worker that was down) is old news: it is not announced.
 */
export function releasedDue(
  events: readonly CalendarRecord[],
  now: number,
  policy: CalendarPolicy,
): CalendarRecord[] {
  return events
    .filter(
      (event) =>
        policyCounts(event, policy) &&
        event.timeMode !== 'date' &&
        event.actual !== null &&
        event.actualFirstSeenAt !== null &&
        now - event.actualFirstSeenAt <= RELEASED_TTL_MS &&
        event.actualFirstSeenAt - event.scheduledAt <= RELEASED_TTL_MS &&
        now - event.scheduledAt >= GOLD_AFTER_READY_MS,
    )
    .sort(byTime);
}

const unitsOf = (event: CalendarRecord): ValueUnits => ({
  unit: event.unit,
  multiplier: event.multiplier,
  digits: event.digits,
});

// ------------------------------------------------------------------------------------ upcoming

export interface UpcomingData {
  readonly event: CalendarRecord;
  readonly now: number;
  /** The news window the event opens (minutes before and after); null when it opens none. */
  readonly window: { readonly before: number; readonly after: number } | null;
}

/** NEWS_UPCOMING: `HIGH-IMPACT USD EVENT in 30 min: CPI m/m (18:00 IST)` with forecast, previous and the window it opens. */
export function newsUpcomingMessage(data: UpcomingData, options: DisplayOptions): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const { event, now } = data;
  const minutes = Math.max(1, Math.ceil((event.scheduledAt - now) / 60_000));
  const when = clockText(event.scheduledAt, options.displayTz, now);
  const units = unitsOf(event);
  const label = w.importanceLabel[event.importance];
  const currency = clean(event.currency ?? '');
  const name = clean(event.name);
  const lines = [
    `${ICON.macro} ${bold(w.upcomingTitle(label, currency, spanText(minutes * 60_000), name, when))}`,
    w.forecastPrevious(valueText(event.forecast, units), valueText(event.previous, units)),
  ];
  if (data.window !== null) {
    const { before, after } = data.window;
    lines.push(
      w.windowNote(
        clockText(event.scheduledAt - before * 60_000, options.displayTz, now),
        clockText(event.scheduledAt + after * 60_000, options.displayTz, now),
      ),
    );
  }
  return systemMessage('NEWS_UPCOMING', lines, {
    title: `${ALERT_WORDS.en.importanceLabel[event.importance]}${currency === '' ? '' : ` ${currency}`} EVENT in ${spanText(minutes * 60_000)}`,
    body: `${name}, ${when}.`,
    urgency: 'normal',
    url: '/news',
  });
}

// ------------------------------------------------------------------------------------ released

/** Where gold was `seconds` after the scheduled time, from the stored ticks. */
export interface GoldAfter {
  readonly seconds: number;
  readonly moveUsd: number;
  readonly spread: number | null;
}

export interface ReleasedData {
  readonly event: CalendarRecord;
  /** The surprise in standard deviations (`surpriseOf`); null when it cannot be told. */
  readonly sigma: number | null;
  /** Null when gold could not be measured (no stored tick near the time). */
  readonly goldAfter: GoldAfter | null;
  /** The event opens a news window, so signals around it carry the warning. */
  readonly opensWindow: boolean;
}

/** NEWS_RELEASED: the released figures, the surprise and where gold was 15 s later; nothing is said that could not be measured. */
export function newsReleasedMessage(data: ReleasedData, options: DisplayOptions): SystemMessage {
  const { event } = data;
  if (event.actual === null) {
    throw new RangeError('an event that was not released has no release message');
  }
  const w = ALERT_WORDS[options.locale];
  const units = unitsOf(event);
  const when = clockText(
    event.scheduledAt,
    options.displayTz,
    event.actualFirstSeenAt ?? undefined,
  );
  const name = clean(event.name);
  const actual = valueText(event.actual, units);
  const lines = [
    `${ICON.released} ${bold(w.releasedTitle(name, when))}`,
    w.releasedFigures(
      actual,
      valueText(event.forecast, units),
      valueText(event.previous, units),
      event.revisedPrevious === null ? null : valueText(event.revisedPrevious, units),
      data.sigma === null ? null : sigmaText(data.sigma),
    ),
  ];
  if (data.goldAfter !== null) {
    const { seconds, moveUsd, spread } = data.goldAfter;
    lines.push(
      w.goldAfter(seconds, signedPriceText(moveUsd), spread === null ? null : priceText(spread)),
    );
  }
  if (data.opensWindow) lines.push(w.releasedWindowNote);
  return systemMessage('NEWS_RELEASED', lines, {
    title: `${name} released`,
    body: `Actual ${actual}, forecast ${valueText(event.forecast, units)}.`,
    urgency: 'normal',
    url: '/news',
  });
}

// ------------------------------------------------------------------------------------- outbox

/**
 * The channels told about a calendar message: the system rule (Telegram when it is on and the kind
 * is switched on, Web Push when it is on), and only for an event of at least the impact that the
 * news alerts of the settings ask for.
 */
export function calendarChannels(
  settings: AlertSettings,
  kind: 'NEWS_UPCOMING' | 'NEWS_RELEASED',
  importance: MacroImportance,
): ReturnType<typeof systemChannels> {
  if (!importanceAtLeast(importance, IMPORTANCE_OF[settings.newsAlerts.minImpact])) return [];
  return systemChannels(settings, kind);
}

/** The rows of NEWS_UPCOMING: one for each channel, valid until the event itself (a late alert is worthless). */
export function upcomingOutboxRows(
  data: UpcomingData,
  settings: AlertSettings,
  now: number,
): OutboxRow[] {
  const channels = calendarChannels(settings, 'NEWS_UPCOMING', data.event.importance);
  return systemOutboxRows(
    newsUpcomingMessage(data, displayOptionsOf(settings)),
    calendarEventKey(data.event.id, 'upcoming'),
    channels,
    now,
    Math.max(1_000, data.event.scheduledAt - now),
  );
}

/** The rows of NEWS_RELEASED: valid for `RELEASED_TTL_MS`. */
export function releasedOutboxRows(
  data: ReleasedData,
  settings: AlertSettings,
  now: number,
): OutboxRow[] {
  const channels = calendarChannels(settings, 'NEWS_RELEASED', data.event.importance);
  return systemOutboxRows(
    newsReleasedMessage(data, displayOptionsOf(settings)),
    calendarEventKey(data.event.id, 'released'),
    channels,
    now,
    RELEASED_TTL_MS,
  );
}
