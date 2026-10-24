import {
  headlinesResponseSchema,
  marketMovesResponseSchema,
  newsEventsResponseSchema,
  newsStateResponseSchema,
  type CalendarEvent,
  type HeadlinesResponse,
  type MacroEvent,
  type MarketMovesQuery,
  type MarketMovesResponse,
  type NewsEventsQuery,
  type NewsEventsResponse,
  type NewsStateResponse,
} from '@vmgs/contracts';
import type { NewsImpact } from '@vmgs/core';

import { ApiError } from '../api/client';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The calendar feed of the preview has been unavailable for this long in the state `UNKNOWN`. */
export const CALENDAR_OUTAGE_S = 3 * 3600 + 12 * 60;
/** The headline feeds have been unavailable for this long in the state `UNKNOWN`. */
export const HEADLINE_OUTAGE_MS = 2 * HOUR_MS;

/** The calendar answers with the last 14 days and the next 8 days when no range is asked for. */
const DEFAULT_PAST_DAYS = 14;
const DEFAULT_FUTURE_DAYS = 8;
/** The market moves of the last 30 days when no range is asked for. */
const DEFAULT_MOVES_DAYS = 30;

export type NewsScenarioState = 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN';

function uuidWith(prefix: number, n: number): string {
  return `00000000-0000-4000-8000-${(prefix + n).toString(16).padStart(12, '0')}`;
}
const eventId = (n: number) => uuidWith(0xe000, n);
const headlineId = (n: number) => uuidWith(0xe000, 10 + n);

// ---------------------------------------------------------------------------------------------
// Calendar

interface CalendarSpec {
  readonly n: number;
  readonly name: string;
  readonly importance: 'low' | 'medium' | 'high';
  readonly unit: string | null;
  /** Whole days from today (UTC) and the time of day in minutes after midnight UTC ... */
  readonly day?: number;
  readonly minutes?: number;
  /** ... or minutes before now (an event of today, whose release has just happened). */
  readonly agoMinutes?: number;
  readonly forecast: number | null;
  readonly previous: number | null;
  /** Released events only: actual, revised previous, surprise in sigma and the move of gold. */
  readonly released?: {
    readonly actual: number;
    readonly revised: number | null;
    readonly sigma: number | null;
    readonly move: { usd: number; atr: number } | null;
  };
}

/** Events that are still to come. The first one (CPI) is added by the preview state, 22 minutes or 4 hours from now. */
const UPCOMING: readonly CalendarSpec[] = [
  {
    n: 2,
    name: 'US initial jobless claims (simulated)',
    importance: 'medium',
    unit: 'K',
    day: 1,
    minutes: 13 * 60,
    forecast: 225,
    previous: 231,
  },
  {
    n: 3,
    name: 'US retail sales m/m (simulated)',
    importance: 'medium',
    unit: '%',
    day: 1,
    minutes: 12 * 60 + 30,
    forecast: 0.4,
    previous: 0.1,
  },
  {
    n: 4,
    name: 'FOMC meeting minutes (simulated)',
    importance: 'high',
    unit: null,
    day: 2,
    minutes: 18 * 60,
    forecast: null,
    previous: null,
  },
  {
    n: 5,
    name: 'US ISM services PMI (simulated)',
    importance: 'medium',
    unit: null,
    day: 3,
    minutes: 14 * 60,
    forecast: 52.1,
    previous: 51.8,
  },
  {
    n: 6,
    name: 'US non-farm payrolls (simulated)',
    importance: 'high',
    unit: 'K',
    day: 4,
    minutes: 12 * 60 + 30,
    forecast: 180,
    previous: 142,
  },
  {
    n: 7,
    name: 'Fed chair speech (simulated)',
    importance: 'medium',
    unit: null,
    day: 5,
    minutes: 15 * 60,
    forecast: null,
    previous: null,
  },
  {
    n: 8,
    name: 'US consumer sentiment (simulated)',
    importance: 'low',
    unit: null,
    day: 6,
    minutes: 14 * 60,
    forecast: 68.5,
    previous: 69.1,
  },
  // Beyond the default range of the calendar (8 days ahead): only an explicit `to` returns it.
  {
    n: 9,
    name: 'US durable goods orders m/m, final (simulated)',
    importance: 'medium',
    unit: '%',
    day: 8,
    minutes: 12 * 60 + 30,
    forecast: 0.4,
    previous: 0.3,
  },
];

/**
 * Events whose time has passed, newest first. The first one has no value yet: the feed has not
 * delivered it, and the page must say so instead of showing an empty cell as if it were zero.
 */
const PAST: readonly CalendarSpec[] = [
  {
    n: 20,
    name: 'US durable goods orders m/m (simulated)',
    importance: 'medium',
    unit: '%',
    agoMinutes: 50,
    forecast: 0.5,
    previous: 0.2,
  },
  {
    n: 21,
    name: 'US PPI m/m (simulated)',
    importance: 'medium',
    unit: '%',
    day: -1,
    minutes: 12 * 60 + 30,
    forecast: 0.3,
    previous: 0.1,
    released: { actual: 0.2, revised: 0.2, sigma: -0.8, move: { usd: -0.9, atr: -0.2 } },
  },
  {
    n: 22,
    name: 'US initial jobless claims (simulated)',
    importance: 'medium',
    unit: 'K',
    day: -2,
    minutes: 13 * 60,
    forecast: 230,
    previous: 228,
    released: { actual: 231, revised: 229, sigma: 0.3, move: { usd: 0.6, atr: 0.1 } },
  },
  {
    n: 23,
    name: 'US industrial production m/m (simulated)',
    importance: 'low',
    unit: '%',
    day: -3,
    minutes: 13 * 60 + 15,
    forecast: 0.1,
    previous: -0.2,
    released: { actual: 0.1, revised: null, sigma: 0, move: { usd: 0.2, atr: 0 } },
  },
  {
    n: 24,
    name: 'FOMC rate decision (simulated)',
    importance: 'high',
    unit: '%',
    day: -5,
    minutes: 18 * 60,
    forecast: 4.25,
    previous: 4.5,
    released: { actual: 4.25, revised: null, sigma: 0, move: { usd: 6.4, atr: 1.4 } },
  },
  {
    n: 25,
    name: 'US core PCE m/m (simulated)',
    importance: 'high',
    unit: '%',
    day: -6,
    minutes: 12 * 60 + 30,
    forecast: 0.2,
    previous: 0.3,
    released: { actual: 0.3, revised: 0.3, sigma: 1.1, move: { usd: -2.8, atr: -0.6 } },
  },
  {
    n: 26,
    name: 'US ADP employment (simulated)',
    importance: 'medium',
    unit: 'K',
    day: -8,
    minutes: 12 * 60 + 15,
    forecast: 150,
    previous: 165,
    released: { actual: 122, revised: 168, sigma: -1.6, move: { usd: 3.9, atr: 0.9 } },
  },
  {
    n: 27,
    name: 'US non-farm payrolls (simulated)',
    importance: 'high',
    unit: 'K',
    day: -9,
    minutes: 12 * 60 + 30,
    forecast: 185,
    previous: 142,
    released: { actual: 212, revised: 156, sigma: 1.8, move: { usd: -7.3, atr: -1.6 } },
  },
  {
    n: 28,
    name: 'US ISM manufacturing PMI (simulated)',
    importance: 'medium',
    unit: null,
    day: -11,
    minutes: 14 * 60,
    forecast: 49.5,
    previous: 48.9,
    released: { actual: 50.1, revised: null, sigma: 1.0, move: { usd: -1.4, atr: -0.3 } },
  },
  {
    n: 29,
    name: 'US GDP q/q (simulated)',
    importance: 'high',
    unit: '%',
    day: -13,
    minutes: 12 * 60 + 30,
    forecast: 2.8,
    previous: 3.0,
    released: { actual: 3.1, revised: null, sigma: null, move: null },
  },
  // Older than the default range of the calendar (14 days back): only an explicit `from` returns it.
  {
    n: 30,
    name: 'US trade balance (simulated)',
    importance: 'low',
    unit: null,
    day: -15,
    minutes: 13 * 60 + 30,
    forecast: -68.5,
    previous: -70.1,
    released: { actual: -67.9, revised: null, sigma: 0.4, move: { usd: 0.3, atr: 0.1 } },
  },
];

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function eventOf(spec: CalendarSpec, nowMs: number): CalendarEvent {
  const scheduledMs =
    spec.agoMinutes === undefined
      ? startOfUtcDay(nowMs) + (spec.day ?? 0) * DAY_MS + (spec.minutes ?? 0) * MINUTE_MS
      : nowMs - spec.agoMinutes * MINUTE_MS;
  const r = spec.released;
  return {
    id: eventId(spec.n),
    name: spec.name,
    scheduledAt: new Date(scheduledMs).toISOString(),
    importance: spec.importance,
    currency: 'USD',
    unit: spec.unit,
    actual: r?.actual ?? null,
    forecast: spec.forecast,
    previous: spec.previous,
    revisedPrevious: r?.revised ?? null,
    surpriseSigma: r?.sigma ?? null,
    goldMoveAfter: r?.move ?? null,
  };
}

/** The next high-impact event: 22 minutes away inside the news window, otherwise 4 hours away. */
function nextEvent(state: NewsScenarioState, nowMs: number): CalendarEvent {
  const minutes = state === 'IN_WINDOW' ? 22 : 240;
  return {
    id: eventId(1),
    name: 'US CPI (simulated)',
    scheduledAt: new Date(nowMs + minutes * MINUTE_MS).toISOString(),
    importance: 'high',
    currency: 'USD',
    unit: '%',
    actual: null,
    forecast: 0.3,
    previous: 0.4,
    revisedPrevious: null,
    surpriseSigma: null,
    goldMoveAfter: null,
  };
}

/** The part of a calendar event that the news state and the stream carry. */
function plain(event: CalendarEvent): MacroEvent {
  return {
    id: event.id,
    name: event.name,
    scheduledAt: event.scheduledAt,
    importance: event.importance,
    currency: event.currency,
    unit: event.unit,
    actual: event.actual,
    forecast: event.forecast,
    previous: event.previous,
    revisedPrevious: event.revisedPrevious,
  };
}

/** The newest event whose value has been delivered. */
function lastReleased(nowMs: number): CalendarEvent | undefined {
  return PAST.map((spec) => eventOf(spec, nowMs)).find((event) => event.actual !== null);
}

export function newsStateAt(state: NewsScenarioState, nowMs: number): NewsStateResponse {
  const last = lastReleased(nowMs);
  return newsStateResponseSchema.parse({
    state,
    // With the calendar feed down the system cannot say what comes next.
    next: state === 'UNKNOWN' ? null : plain(nextEvent(state, nowMs)),
    last: last ? plain(last) : null,
    sourceAgeS: state === 'UNKNOWN' ? CALENDAR_OUTAGE_S : 45,
  });
}

/**
 * The calendar of the preview, oldest first: the events of the last two weeks and of the next
 * week. With the calendar feed down (`UNKNOWN`) the stored past is still there but nothing that
 * is still to come: what comes next is not known.
 */
export function newsEventsAt(
  state: NewsScenarioState,
  nowMs: number,
  query: NewsEventsQuery,
): NewsEventsResponse {
  const upcoming =
    state === 'UNKNOWN'
      ? []
      : [nextEvent(state, nowMs), ...UPCOMING.map((spec) => eventOf(spec, nowMs))];
  const from =
    query.from === undefined
      ? startOfUtcDay(nowMs) - DEFAULT_PAST_DAYS * DAY_MS
      : Date.parse(query.from);
  const to =
    query.to === undefined
      ? startOfUtcDay(nowMs) + DEFAULT_FUTURE_DAYS * DAY_MS
      : Date.parse(query.to);
  const items = [...PAST.map((spec) => eventOf(spec, nowMs)), ...upcoming]
    .filter((event) => {
      const at = Date.parse(event.scheduledAt);
      return (
        at >= from &&
        at < to &&
        (query.importance === undefined || event.importance === query.importance)
      );
    })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  return newsEventsResponseSchema.parse({
    items,
    sourceAgeS: state === 'UNKNOWN' ? CALENDAR_OUTAGE_S : 45,
  });
}

// ---------------------------------------------------------------------------------------------
// Headlines

interface HeadlineSpec {
  readonly n: number;
  readonly title: string;
  readonly minutesAgo: number;
  readonly delayS: number | null;
  readonly sources: readonly string[];
  readonly topics: readonly string[];
  readonly impact: NewsImpact;
  readonly move: { usd: number; atr: number } | null;
}

export const NEWS_SOURCES = [
  { key: 'sim-a', name: 'Simulated feed A' },
  { key: 'sim-b', name: 'Simulated feed B' },
  { key: 'sim-c', name: 'Simulated feed C' },
] as const;

/** Newest first. The three newest are the ones the dashboard shows. */
const HEADLINES: readonly HeadlineSpec[] = [
  {
    n: 1,
    title: 'Simulated headline: central bank speaker comments on the rate path',
    minutesAgo: 12,
    delayS: 120,
    sources: ['sim-a'],
    topics: ['FED_RATES'],
    impact: 'MEDIUM',
    move: { usd: 1.2, atr: 0.3 },
  },
  {
    n: 2,
    title: 'Simulated headline: dollar index edges lower before US data',
    minutesAgo: 35,
    delayS: 60,
    sources: ['sim-a', 'sim-b'],
    topics: ['USD_DOLLAR'],
    impact: 'LOW',
    move: { usd: -0.4, atr: -0.1 },
  },
  {
    n: 3,
    title: 'Simulated headline: geopolitical tension lifts demand for safe assets',
    minutesAgo: 80,
    delayS: 180,
    sources: ['sim-b'],
    topics: ['GEOPOLITICS_WAR', 'RISK_OFF'],
    impact: 'HIGH',
    move: { usd: 3.1, atr: 0.7 },
  },
  {
    n: 4,
    title: 'Simulated headline: new tariffs announced on imported steel',
    minutesAgo: 125,
    delayS: 90,
    sources: ['sim-a', 'sim-b', 'sim-c'],
    topics: ['TRUMP_POLICY'],
    impact: 'HIGH',
    move: { usd: 2.2, atr: 0.5 },
  },
  {
    n: 5,
    title: 'Simulated headline: Treasury yields slip as traders price a rate cut',
    minutesAgo: 190,
    delayS: 240,
    sources: ['sim-c'],
    topics: ['FED_RATES', 'USD_DOLLAR'],
    impact: 'MEDIUM',
    move: { usd: 0.8, atr: 0.2 },
  },
  {
    n: 6,
    title: 'Simulated headline: gold ETF holdings rise for a third week',
    minutesAgo: 300,
    delayS: 300,
    sources: ['sim-b'],
    topics: ['GOLD_DIRECT'],
    impact: 'LOW',
    move: { usd: 0.3, atr: 0.1 },
  },
  {
    n: 7,
    title: 'Simulated headline: inflation data due, economists expect a small rise',
    minutesAgo: 420,
    delayS: 120,
    sources: ['sim-a', 'sim-c'],
    topics: ['INFLATION_JOBS'],
    impact: 'MEDIUM',
    move: { usd: -0.5, atr: -0.1 },
  },
  {
    n: 8,
    title: 'Simulated headline: a central bank adds to its gold reserves',
    minutesAgo: 560,
    delayS: null,
    sources: ['sim-c'],
    topics: ['CENTRAL_BANK_GOLD'],
    impact: 'MEDIUM',
    move: null,
  },
  {
    n: 9,
    title: 'Simulated headline: regional bank shares fall sharply in early trade',
    minutesAgo: 780,
    delayS: 150,
    sources: ['sim-a'],
    topics: ['RISK_OFF'],
    impact: 'HIGH',
    move: { usd: 4.4, atr: 1.0 },
  },
  {
    n: 10,
    title: 'Simulated headline: ceasefire talks resume after a pause',
    minutesAgo: 1020,
    delayS: 200,
    sources: ['sim-b', 'sim-c'],
    topics: ['GEOPOLITICS_WAR'],
    impact: 'MEDIUM',
    move: { usd: -1.6, atr: -0.4 },
  },
  {
    n: 11,
    title: 'Simulated headline: jobs report beats forecasts, dollar firms',
    minutesAgo: 1260,
    delayS: 60,
    sources: ['sim-a', 'sim-b'],
    topics: ['INFLATION_JOBS', 'USD_DOLLAR'],
    impact: 'HIGH',
    move: { usd: -5.2, atr: -1.2 },
  },
  {
    n: 12,
    title: 'Simulated headline: gold edges higher in quiet Asian trade',
    minutesAgo: 1560,
    delayS: 480,
    sources: ['sim-c'],
    topics: ['GOLD_DIRECT'],
    impact: 'LOW',
    move: { usd: 0.7, atr: 0.2 },
  },
  {
    n: 13,
    title: 'Simulated headline: Fed official says more evidence is needed before a cut',
    minutesAgo: 1800,
    delayS: 100,
    sources: ['sim-a'],
    topics: ['FED_RATES'],
    impact: 'MEDIUM',
    move: { usd: -1.1, atr: -0.3 },
  },
  {
    n: 14,
    title: 'Simulated headline: sanctions package expected to be announced this week',
    minutesAgo: 2400,
    delayS: 360,
    sources: ['sim-b'],
    topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
    impact: 'MEDIUM',
    move: { usd: 0.9, atr: 0.2 },
  },
];

const IMPACT_RANK: Readonly<Record<NewsImpact, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function encodeCursor(offset: number): string {
  return `h${String(offset)}`;
}

function decodeCursor(cursor: string): number {
  const match = /^h(\d{1,5})$/.exec(cursor);
  if (!match)
    throw new ApiError(400, 'invalid_cursor', 'This cursor does not belong to this list.');
  return Number(match[1]);
}

function sourceName(key: string): string {
  return NEWS_SOURCES.find((source) => source.key === key)?.name ?? key;
}

/**
 * The headlines of the preview, newest first, filtered and paged like the real list. With the
 * headline feeds down (`UNKNOWN`) the list holds only what was stored before the outage, and every
 * source reports its error: "feed unavailable" must never look like "no news".
 */
/** The query of the headline list after the contract has parsed it (the page size has its default). */
export interface HeadlinesFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly minImpact?: NewsImpact | undefined;
  readonly topic?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export function headlinesAt(
  nowMs: number,
  query: HeadlinesFilter,
  state: NewsScenarioState = 'CLEAR',
): HeadlinesResponse {
  const down = state === 'UNKNOWN';
  const outageStart = nowMs - HEADLINE_OUTAGE_MS;
  const from = query.from === undefined ? -Infinity : Date.parse(query.from);
  const to = query.to === undefined ? Infinity : Date.parse(query.to);
  const minRank = query.minImpact === undefined ? 0 : IMPACT_RANK[query.minImpact];
  const matching = HEADLINES.map((spec) => ({
    spec,
    seenMs: nowMs - (spec.minutesAgo - (spec.delayS ?? 0) / 60) * MINUTE_MS,
  })).filter(({ spec, seenMs }) => {
    if (down && seenMs > outageStart) return false;
    if (seenMs < from || seenMs >= to) return false;
    if (IMPACT_RANK[spec.impact] < minRank) return false;
    return query.topic === undefined || spec.topics.includes(query.topic);
  });
  const limit = query.limit;
  const offset = query.cursor === undefined ? 0 : decodeCursor(query.cursor);
  const page = matching.slice(offset, offset + limit);
  const next = offset + page.length;
  return headlinesResponseSchema.parse({
    items: page.map(({ spec, seenMs }) => ({
      id: headlineId(spec.n),
      title: spec.title,
      sources: spec.sources.map((key) => ({ key, name: sourceName(key) })),
      publishedAt: new Date(nowMs - spec.minutesAgo * MINUTE_MS).toISOString(),
      firstSeenAt: new Date(seenMs).toISOString(),
      delayS: spec.delayS,
      topics: spec.topics,
      impact: spec.impact,
      url: `https://example.com/simulated-${String(spec.n)}`,
      goldMoveSincePublish: spec.move,
    })),
    nextCursor: next < matching.length ? encodeCursor(next) : null,
    sources: NEWS_SOURCES.map((source) => ({
      key: source.key,
      name: source.name,
      enabled: true,
      lastOkAt: new Date(down ? outageStart : nowMs - MINUTE_MS).toISOString(),
      lastError: down ? 'Timed out after 20 s' : null,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Market moves

interface MoveSpec {
  readonly id: number;
  readonly minutesAgo: number;
  readonly kind: 'SPIKE_UP' | 'SPIKE_DOWN';
  readonly windowS: number;
  readonly moveUsd: number;
  readonly moveAtr: number;
  readonly spread: number | null;
  readonly headlines: readonly {
    title: string;
    sources: readonly string[];
    minutesBefore: number;
    impact: NewsImpact | null;
    topics: readonly string[];
  }[];
}

/** Newest first. One move has no headline at all, one has only unclassified ones (timing only). */
const MOVES: readonly MoveSpec[] = [
  {
    id: 5,
    minutesAgo: 160,
    kind: 'SPIKE_UP',
    windowS: 300,
    moveUsd: 9.8,
    moveAtr: 2.8,
    spread: 0.35,
    headlines: [
      {
        title: 'Simulated headline: missile strike reported near a shipping lane',
        sources: ['Simulated feed A', 'Simulated feed B'],
        minutesBefore: 16,
        impact: 'HIGH',
        topics: ['GEOPOLITICS_WAR'],
      },
      {
        title: 'Simulated headline: Treasury yields fall as investors seek safety',
        sources: ['Simulated feed C'],
        minutesBefore: 7,
        impact: 'MEDIUM',
        topics: ['FED_RATES'],
      },
      {
        title: 'Simulated headline: local council approves a new harbour project',
        sources: ['Simulated feed B'],
        minutesBefore: 3,
        impact: null,
        topics: [],
      },
    ],
  },
  {
    id: 4,
    minutesAgo: 1740,
    kind: 'SPIKE_DOWN',
    windowS: 300,
    moveUsd: 7.2,
    moveAtr: 2.1,
    spread: 0.28,
    headlines: [
      {
        title: 'Simulated headline: jobs report beats forecasts, dollar firms',
        sources: ['Simulated feed A', 'Simulated feed B'],
        minutesBefore: 4,
        impact: 'HIGH',
        topics: ['INFLATION_JOBS', 'USD_DOLLAR'],
      },
    ],
  },
  {
    id: 3,
    minutesAgo: 3000,
    kind: 'SPIKE_UP',
    windowS: 60,
    moveUsd: 4.1,
    moveAtr: 3.2,
    spread: 0.5,
    headlines: [],
  },
  {
    id: 2,
    minutesAgo: 5800,
    kind: 'SPIKE_DOWN',
    windowS: 300,
    moveUsd: 11.3,
    moveAtr: 2.6,
    spread: 0.41,
    headlines: [
      {
        title: 'Simulated headline: new tariffs announced on imported steel',
        sources: ['Simulated feed A', 'Simulated feed B', 'Simulated feed C'],
        minutesBefore: 22,
        impact: 'HIGH',
        topics: ['TRUMP_POLICY'],
      },
      {
        title: 'Simulated headline: festival organisers confirm opening night',
        sources: ['Simulated feed C'],
        minutesBefore: 6,
        impact: null,
        topics: [],
      },
    ],
  },
  {
    id: 1,
    minutesAgo: 9900,
    kind: 'SPIKE_UP',
    windowS: 300,
    moveUsd: 6.0,
    moveAtr: 2.2,
    spread: null,
    headlines: [
      {
        title: 'Simulated headline: a football club appoints a new coach',
        sources: ['Simulated feed B'],
        minutesBefore: 14,
        impact: null,
        topics: [],
      },
      {
        title: 'Simulated headline: weather service warns of storms overnight',
        sources: ['Simulated feed C'],
        minutesBefore: 2,
        impact: null,
        topics: [],
      },
    ],
  },
  // Older than the default range of the moves (30 days): only an explicit `from` returns it.
  {
    id: 6,
    minutesAgo: 44_500,
    kind: 'SPIKE_DOWN',
    windowS: 300,
    moveUsd: 8.4,
    moveAtr: 2.3,
    spread: 0.33,
    headlines: [],
  },
];

/** Detected moves of the preview, newest first, in the range asked for (the last 30 days by default). */
export function marketMovesAt(nowMs: number, query: MarketMovesQuery): MarketMovesResponse {
  const from =
    query.from === undefined ? nowMs - DEFAULT_MOVES_DAYS * DAY_MS : Date.parse(query.from);
  const to = query.to === undefined ? Infinity : Date.parse(query.to);
  const items = MOVES.map((move) => ({ move, at: nowMs - move.minutesAgo * MINUTE_MS }))
    .filter(({ at }) => at >= from && at < to)
    .map(({ move, at }) => ({
      id: move.id,
      detectedAt: new Date(at).toISOString(),
      kind: move.kind,
      windowS: move.windowS,
      moveUsd: move.moveUsd,
      moveAtr: move.moveAtr,
      spread: move.spread,
      headlines: move.headlines.map((headline, index) => ({
        title: headline.title,
        sources: headline.sources,
        publishedAt: new Date(at - headline.minutesBefore * MINUTE_MS).toISOString(),
        impact: headline.impact,
        topics: headline.topics,
        url: `https://example.com/simulated-move-${String(move.id)}-${String(index + 1)}`,
        classified: headline.impact !== null,
      })),
    }));
  return marketMovesResponseSchema.parse({ items });
}
