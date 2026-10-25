import { fromMilli, toMilli } from '@vmgs/core';

/** HistData stamps its files in Eastern Standard Time all year round: UTC-5, no daylight saving. */
export const HISTDATA_UTC_OFFSET_MS = 5 * 3_600_000;

/** A price outside these bounds is a corrupt row (a missing decimal point, a zero), not a market move. */
export const PRICE_BOUNDS = { min: 50, max: 50_000 } as const;

export const REJECT_REASONS = [
  'MALFORMED',
  'BAD_TIME',
  'BAD_PRICE',
  'BAD_OHLC',
  'ASK_BELOW_BID',
  'DUPLICATE',
  'OUT_OF_ORDER',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** One M1 bar of bid prices. `ts` is the open of the minute in UTC. */
export interface BidBar {
  readonly ts: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** One quote of a tick file. `ts` is in UTC with millisecond resolution. */
export interface QuoteTick {
  readonly ts: number;
  readonly bid: number;
  readonly ask: number;
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: RejectReason };

const STAMP = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})(\d{3})?$/;
const PRICE = /^\d{1,6}(?:\.\d{1,8})?$/;

const fail = (reason: RejectReason): { ok: false; reason: RejectReason } => ({ ok: false, reason });

/** `20230102 180000` (or with milliseconds) in HistData's UTC-5 to epoch milliseconds in UTC; null when it is not a real instant. */
function stampToUtc(text: string, withMillis: boolean): number | null {
  const found = STAMP.exec(text);
  if (found === null || (found[7] !== undefined) !== withMillis) return null;
  const num = (index: number): number => Number(found[index] ?? 0);
  const [year, month, day, hour, minute, second] = [num(1), num(2), num(3), num(4), num(5), num(6)];
  const local = Date.UTC(year, month - 1, day, hour, minute, second, num(7));
  const check = new Date(local);
  // Date.UTC rolls an impossible date over (31 February, hour 24): only an exact round trip is a real stamp.
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  return real ? local + HISTDATA_UTC_OFFSET_MS : null;
}

/** A price with at most 3 decimals (the precision of the tables), inside the sane bounds; null otherwise. */
function priceOf(text: string): number | null {
  if (!PRICE.test(text)) return null;
  const price = fromMilli(toMilli(Number(text)));
  return price >= PRICE_BOUNDS.min && price <= PRICE_BOUNDS.max ? price : null;
}

/** An M1 line `DateTime;Open;High;Low;Close;Volume` of bid prices. Null for a blank line. */
export function parseBarLine(line: string): Parsed<BidBar> | null {
  const text = line.trim();
  if (text === '') return null;
  const parts = text.split(';');
  if (parts.length !== 6) return fail('MALFORMED');
  const [stamp = '', open = '', high = '', low = '', close = ''] = parts;
  const ts = stampToUtc(stamp, false);
  if (ts === null || ts % 60_000 !== 0) return fail('BAD_TIME');
  const o = priceOf(open);
  const h = priceOf(high);
  const l = priceOf(low);
  const c = priceOf(close);
  if (o === null || h === null || l === null || c === null) return fail('BAD_PRICE');
  if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) return fail('BAD_OHLC');
  return { ok: true, value: { ts, o, h, l, c } };
}

/** A tick line `DateTime,Bid,Ask,Volume` with the milliseconds in the stamp. Null for a blank line. */
export function parseTickLine(line: string): Parsed<QuoteTick> | null {
  const text = line.trim();
  if (text === '') return null;
  const parts = text.split(',');
  if (parts.length !== 4) return fail('MALFORMED');
  const [stamp = '', bidText = '', askText = ''] = parts;
  const ts = stampToUtc(stamp, true);
  if (ts === null) return fail('BAD_TIME');
  const bid = priceOf(bidText);
  const ask = priceOf(askText);
  if (bid === null || ask === null) return fail('BAD_PRICE');
  if (ask < bid) return fail('ASK_BELOW_BID');
  return { ok: true, value: { ts, bid, ask } };
}
