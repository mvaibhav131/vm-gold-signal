import {
  causeCodeSchema,
  gradeSchema,
  regimeSchema,
  resultSchema,
  sessionSchema,
  sideSchema,
  signalSortSchema,
  sortOrderSchema,
  strategyKeySchema,
  type SignalSort,
} from '@vmgs/contracts';
import {
  CAUSE_CODES,
  GRADES,
  REGIMES,
  RESULTS,
  SESSIONS,
  STRATEGY_KEYS,
  addCivilDays,
  zonedWallTimeToUtc,
} from '@vmgs/core';

import type { HistoryFilters } from '../data/queries';
import { labelOf } from '../format/format';
import { CAUSE_LABELS, RESULT_LABELS, STRATEGY_LABELS } from '../format/signal';

/** The filters that are a choice from a list. Their names are the names in the address bar and in the test ids. */
export const SELECT_FILTERS = [
  'result',
  'strategy',
  'side',
  'session',
  'regime',
  'cause',
  'grade',
] as const;
export type SelectFilter = (typeof SELECT_FILTERS)[number];

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export const FILTER_LABELS: Readonly<Record<SelectFilter | 'from' | 'to', string>> = {
  from: 'From',
  to: 'To',
  result: 'Result',
  strategy: 'Strategy',
  side: 'Side',
  session: 'Session',
  regime: 'Regime',
  cause: 'Failure cause',
  grade: 'Grade',
};

export const FILTER_OPTIONS: Readonly<Record<SelectFilter, readonly FilterOption[]>> = {
  result: RESULTS.map((value) => ({ value, label: RESULT_LABELS[value] })),
  strategy: STRATEGY_KEYS.map((value) => ({ value, label: STRATEGY_LABELS[value] })),
  side: [
    { value: 'BUY', label: 'Buy' },
    { value: 'SELL', label: 'Sell' },
  ],
  session: SESSIONS.map((value) => ({ value, label: labelOf(value) })),
  regime: REGIMES.map((value) => ({ value, label: labelOf(value) })),
  cause: CAUSE_CODES.map((value) => ({ value, label: CAUSE_LABELS[value] })),
  grade: GRADES.map((value) => ({ value, label: value })),
};

const VALID: Readonly<Record<SelectFilter, { safeParse: (v: unknown) => { success: boolean } }>> = {
  result: resultSchema,
  strategy: strategyKeySchema,
  side: sideSchema,
  session: sessionSchema,
  regime: regimeSchema,
  cause: causeCodeSchema,
  grade: gradeSchema,
};

interface Civil {
  year: number;
  month: number;
  day: number;
}

/** `2026-10-23` as a calendar date, or null when it is not a real date. */
function civilOf(text: string | null): Civil | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return real ? { year, month, day } : null;
}

const startOfDay = (date: Civil, timeZone: string) =>
  new Date(zonedWallTimeToUtc(date, 0, 0, timeZone)).toISOString();

const dayNumber = (date: Civil) => Date.UTC(date.year, date.month - 1, date.day);

export interface ParsedFilters {
  readonly filters: HistoryFilters;
  /** What each control shows: the valid value of the address bar, or an empty text. */
  readonly values: Readonly<Record<SelectFilter | 'from' | 'to', string>>;
  /** The end date is before the start date: neither is applied. */
  readonly dateError: boolean;
  /** How many filters are set (a date range counts as two). */
  readonly active: number;
}

/**
 * The filters from the address bar (`/signals?result=LOSS&from=2026-10-01`). A value that is not
 * valid is ignored. The dates are calendar days of the display time zone: `from` is the start of its
 * day and `to` the end of its day (the start of the next one).
 */
export function filtersFromParams(params: URLSearchParams, timeZone: string): ParsedFilters {
  const fromText = civilOf(params.get('from')) ? (params.get('from') ?? '') : '';
  const toText = civilOf(params.get('to')) ? (params.get('to') ?? '') : '';
  let from = civilOf(fromText);
  let to = civilOf(toText);
  const dateError = from !== null && to !== null && dayNumber(from) > dayNumber(to);
  if (dateError) {
    from = null;
    to = null;
  }
  const picked: Partial<Record<SelectFilter, string>> = {};
  for (const name of SELECT_FILTERS) {
    const value = params.get(name);
    if (value !== null && VALID[name].safeParse(value).success) picked[name] = value;
  }
  const sort = signalSortSchema.safeParse(params.get('sort'));
  const order = sortOrderSchema.safeParse(params.get('order'));
  const filters = {
    ...(from ? { from: startOfDay(from, timeZone) } : {}),
    ...(to ? { to: startOfDay(addCivilDays(to, 1), timeZone) } : {}),
    ...picked,
    ...(sort.success ? { sort: sort.data } : {}),
    ...(order.success ? { order: order.data } : {}),
  } as HistoryFilters;
  const active = Object.keys(picked).length + (from ? 1 : 0) + (to ? 1 : 0);
  const values = { from: fromText, to: toText } as Record<SelectFilter | 'from' | 'to', string>;
  for (const name of SELECT_FILTERS) values[name] = picked[name] ?? '';
  return { filters, values, dateError, active };
}

/** The sort the table starts with: newest first. */
export const DEFAULT_SORT: { sort: SignalSort; order: 'asc' | 'desc' } = {
  sort: 'generatedAt',
  order: 'desc',
};

/** Sets one value of the address bar; an empty value removes it. Changing a filter drops nothing else. */
export function withParam(params: URLSearchParams, name: string, value: string | null) {
  const next = new URLSearchParams(params);
  if (value === null || value === '') next.delete(name);
  else next.set(name, value);
  return next;
}

/** The sort of a column: the default (newest first) is not written to the address bar. */
export function withSort(params: URLSearchParams, sort: SignalSort, order: 'asc' | 'desc') {
  const next = new URLSearchParams(params);
  if (sort === DEFAULT_SORT.sort && order === DEFAULT_SORT.order) {
    next.delete('sort');
    next.delete('order');
  } else {
    next.set('sort', sort);
    next.set('order', order);
  }
  return next;
}

/** Removes every filter and keeps the sort. */
export function withoutFilters(params: URLSearchParams) {
  const next = new URLSearchParams();
  for (const name of ['sort', 'order']) {
    const value = params.get(name);
    if (value !== null) next.set(name, value);
  }
  return next;
}
