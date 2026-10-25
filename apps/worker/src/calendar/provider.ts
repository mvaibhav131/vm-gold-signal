import type { MacroImportance, TimeMode } from '@vmgs/core';

/** An event of the calendar as the provider gives it, read and checked (times in epoch milliseconds). */
export interface ProviderEvent {
  /** The id of this release (`macro_events.source_event_id`). */
  readonly sourceEventId: string;
  /** The id of the series (CPI m/m), shared by its releases. */
  readonly seriesId: string | null;
  readonly scheduledAt: number;
  readonly countryCode: string | null;
  readonly currency: string | null;
  readonly name: string;
  readonly importance: MacroImportance;
  readonly type: string | null;
  /** The period the figure is about, as the provider writes it (ISO). */
  readonly period: string | null;
  readonly unit: string | null;
  readonly multiplier: string | null;
  readonly digits: number | null;
  readonly actual: number | null;
  readonly forecast: number | null;
  readonly previous: number | null;
  readonly revisedPrevious: number | null;
  /** How often the provider revised the figures of the release. */
  readonly revision: number | null;
  readonly timeMode: TimeMode;
  /** The data source behind the provider (`mql5`, `fxempire`). */
  readonly origin: string | null;
  readonly sourceUrl: string | null;
}

export interface CalendarFetch {
  readonly events: ProviderEvent[];
  /** Rows without a usable importance (holidays, `none`): not stored. */
  readonly skipped: number;
  /** Rows that could not be read (missing id, time or name, a figure that is not a number). */
  readonly invalid: number;
  /** The provider returned as many rows as the limit: the window may have been cut. */
  readonly truncated: boolean;
}

export interface CalendarProvider {
  readonly name: string;
  fetchRange(from: number, to: number): Promise<CalendarFetch>;
  /** The releases of one series, as far as the provider keeps them (about three months). */
  fetchHistory(seriesId: string): Promise<ProviderEvent[]>;
}

export type CalendarErrorKind = 'http' | 'network' | 'timeout' | 'format';

/** A reading of the calendar that failed. The poller backs off and the calendar goes unavailable after a while. */
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly kind: CalendarErrorKind,
    /** The HTTP status, when there was a response. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const IMPORTANCES: readonly string[] = ['low', 'medium', 'high'];
const TIME_MODES: readonly string[] = ['exact', 'tentative', 'date'];

type Figure = number | null | undefined;

/** A figure is a finite number or absent (null); anything else means the row cannot be read. */
function figure(value: unknown): Figure {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Reads one row of `/api/Calendar`. `'skip'` is a row that is not an event with an importance (a
 * holiday: importance `none`), null a row that cannot be read. An unknown `timeMode` is
 * `tentative`, the cautious reading: a time that may move is never counted down to.
 */
export function parseCalendarRow(raw: unknown): ProviderEvent | 'skip' | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const name = text(raw.name);
  const time = typeof raw.time === 'string' ? Date.parse(raw.time) : Number.NaN;
  if (id === null || name === null || !Number.isFinite(time)) return null;
  if (raw.importance === 'none') return 'skip';
  if (typeof raw.importance !== 'string' || !IMPORTANCES.includes(raw.importance)) return null;
  const actual = figure(raw.actual);
  const forecast = figure(raw.forecast);
  const previous = figure(raw.previous);
  const revisedPrevious = figure(raw.revisedPrevious);
  const digits = figure(raw.digits);
  const revision = figure(raw.revision);
  if (
    actual === undefined ||
    forecast === undefined ||
    previous === undefined ||
    revisedPrevious === undefined ||
    digits === undefined ||
    revision === undefined
  ) {
    return null;
  }
  return {
    sourceEventId: id,
    seriesId: text(raw.eventId),
    scheduledAt: time,
    countryCode: text(raw.countryCode),
    currency: text(raw.currency),
    name,
    importance: raw.importance as MacroImportance,
    type: text(raw.type),
    period: text(raw.period),
    unit: text(raw.unit),
    multiplier: text(raw.multiplier),
    digits,
    actual,
    forecast,
    previous,
    revisedPrevious,
    revision,
    timeMode:
      typeof raw.timeMode === 'string' && TIME_MODES.includes(raw.timeMode)
        ? (raw.timeMode as TimeMode)
        : 'tentative',
    origin: text(raw.source),
    sourceUrl: text(raw.sourceUrl),
  };
}

function parseRows(body: unknown): Omit<CalendarFetch, 'truncated'> {
  if (!Array.isArray(body)) throw new CalendarError('the calendar did not return a list', 'format');
  const events: ProviderEvent[] = [];
  let skipped = 0;
  let invalid = 0;
  for (const row of body as unknown[]) {
    const parsed = parseCalendarRow(row);
    if (parsed === 'skip') skipped += 1;
    else if (parsed === null) invalid += 1;
    else events.push(parsed);
  }
  // A list in which nothing can be read means the format changed: that is an outage, not "no events".
  if (invalid > 0 && events.length === 0 && skipped === 0) {
    throw new CalendarError('no row of the calendar could be read', 'format');
  }
  return { events, skipped, invalid };
}

export interface BiquoteCalendarOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Comma-separated codes of the countries asked for. */
  readonly countries?: string;
  /** The most rows one reading asks for (the service allows 1 to 500). */
  readonly limit?: number;
}

/**
 * The economic calendar of Biquote (`GET /api/Calendar`): free, no key, JSON. The reading asks for
 * one window of the countries of the system; the history of a series (`/{eventId}/history`) is
 * used only for the surprise.
 */
export class BiquoteCalendarClient implements CalendarProvider {
  readonly name = 'biquote';
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly countries: string;
  private readonly limit: number;

  constructor(options: BiquoteCalendarOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://biquote.io').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.countries = options.countries ?? 'US';
    this.limit = options.limit ?? 500;
  }

  async fetchRange(from: number, to: number): Promise<CalendarFetch> {
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      countries: this.countries,
      limit: String(this.limit),
    });
    const body = await this.get(`/api/Calendar?${query.toString()}`);
    const rows = parseRows(body);
    return { ...rows, truncated: Array.isArray(body) && body.length >= this.limit };
  }

  async fetchHistory(seriesId: string): Promise<ProviderEvent[]> {
    const body = await this.get(`/api/Calendar/${encodeURIComponent(seriesId)}/history?limit=24`);
    return parseRows(body).events;
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CalendarError(
          `the calendar did not answer in ${String(this.timeoutMs)} ms`,
          'timeout',
        );
      }
      throw new CalendarError(
        `the calendar could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        'network',
      );
    }
    if (!response.ok) {
      throw new CalendarError(
        `the calendar answered ${String(response.status)}`,
        'http',
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new CalendarError('the calendar did not answer with JSON', 'format', response.status);
    }
  }
}
