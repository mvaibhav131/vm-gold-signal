import {
  CandleBuilder,
  HIGHER_TIMEFRAMES,
  MINUTE_MS,
  TRADED_SYMBOL,
  aggregateMinutes,
  fromMilli,
  midMilli,
  toMilli,
  type HigherTimeframe,
  type MarketCandle,
} from '@vmgs/core';

import type { HistSource } from './archive';
import { parseBarLine, parseTickLine, type BidBar, type Parsed, type RejectReason } from './format';

export type HistFormat = 'M1' | 'TICK';

/** Bars have `_M1_` in their file name and ticks `_T_` (`DAT_ASCII_XAUUSD_M1_2023.csv`, `DAT_ASCII_XAUUSD_T_202301.csv`). */
export function formatOf(name: string): HistFormat {
  if (/_M1_/i.test(name)) return 'M1';
  if (/_T_/i.test(name)) return 'TICK';
  throw new Error(
    `cannot tell the HistData format of ${name}: its name must have _M1_ (bars) or _T_ (ticks)`,
  );
}

export interface ImportOptions {
  /** The spread in USD to add to bid bars to get mid prices (the spread model): M1 files carry no ask. */
  readonly spreadAt: (ms: number) => number;
}

export interface RejectSample {
  readonly file: string;
  readonly line: number;
  readonly reason: RejectReason;
  readonly text: string;
}

export interface ImportReport {
  readonly format: HistFormat;
  readonly files: readonly string[];
  /** Non-blank lines read. */
  readonly rows: number;
  readonly accepted: number;
  /** Accepted rows that came behind a later minute and were put in their place (a file that is not in order). */
  readonly reordered: number;
  readonly rejected: Readonly<Partial<Record<RejectReason, number>>>;
  /** The first few rejected lines, to see what is wrong with the file. */
  readonly samples: readonly RejectSample[];
  /** Open time of the first and of the last 1m candle. */
  readonly firstAt: number | null;
  readonly lastAt: number | null;
  readonly minutes: number;
  readonly candles: Readonly<Record<HigherTimeframe, number>>;
}

export interface ImportResult {
  /** 1m candles of mid prices, `source = histdata_bootstrap`. */
  readonly minutes: readonly MarketCandle[];
  /** 5m, 15m, 1h, 4h and 1d candles from the minutes, only those whose time has fully passed. */
  readonly candles: readonly MarketCandle[];
  readonly report: ImportReport;
}

const MAX_SAMPLES = 10;

class Tally {
  rows = 0;
  accepted = 0;
  readonly rejected: Partial<Record<RejectReason, number>> = {};
  readonly samples: RejectSample[] = [];

  reject(file: string, line: number, reason: RejectReason, text: string): void {
    this.rejected[reason] = (this.rejected[reason] ?? 0) + 1;
    if (this.samples.length < MAX_SAMPLES) {
      this.samples.push({ file, line, reason, text: text.trim().slice(0, 120) });
    }
  }
}

function asBootstrap(candle: MarketCandle): MarketCandle {
  return { ...candle, source: 'histdata_bootstrap' };
}

/** A bid bar as a candle of mid prices: the model spread is added to every bid price, half of it up. */
function midBar(bar: BidBar, spreadUsd: number): MarketCandle {
  const spread = toMilli(spreadUsd);
  const mid = (price: number): number => {
    const bid = toMilli(price);
    return fromMilli(midMilli(bid, bid + spread));
  };
  return {
    symbol: TRADED_SYMBOL,
    tf: '1m',
    openTime: bar.ts,
    o: mid(bar.o),
    h: mid(bar.h),
    l: mid(bar.l),
    c: mid(bar.c),
    spreadAvg: null,
    spreadMax: null,
    tickCount: 0,
    complete: true,
    source: 'histdata_bootstrap',
  };
}

function reportOf(
  format: HistFormat,
  files: readonly HistSource[],
  tally: Tally,
  minutes: readonly MarketCandle[],
  candles: readonly MarketCandle[],
  reordered = 0,
): ImportReport {
  const perTimeframe = Object.fromEntries(
    HIGHER_TIMEFRAMES.map((tf) => [tf, candles.filter((candle) => candle.tf === tf).length]),
  ) as Record<HigherTimeframe, number>;
  return {
    format,
    files: files.map((file) => file.name),
    rows: tally.rows,
    accepted: tally.accepted,
    reordered,
    rejected: tally.rejected,
    samples: tally.samples,
    firstAt: minutes[0]?.openTime ?? null,
    lastAt: minutes.at(-1)?.openTime ?? null,
    minutes: minutes.length,
    candles: perTimeframe,
  };
}

function* parsedLines<T>(
  file: HistSource,
  parse: (line: string) => Parsed<T> | null,
  tally: Tally,
): Generator<{ line: number; text: string; value: T }> {
  let line = 0;
  for (const text of file.lines) {
    line += 1;
    const parsed = parse(text);
    if (parsed === null) continue;
    tally.rows += 1;
    if (parsed.ok) yield { line, text, value: parsed.value };
    else tally.reject(file.name, line, parsed.reason, text);
  }
}

/** A minute that was taken, with where it came from: a later row for the same minute may take its place. */
interface KeptBar extends BidBar {
  readonly behind: boolean;
  readonly file: string;
  readonly line: number;
}

const widthOf = (bar: BidBar): number => bar.h - bar.l;

const barText = (bar: BidBar): string =>
  `${new Date(bar.ts).toISOString().slice(0, 16)}Z o=${String(bar.o)} h=${String(bar.h)} l=${String(bar.l)} c=${String(bar.c)}`;

/**
 * Bars of bid prices to mid candles. A file can hold several rows for one minute: the row of a minute that was
 * still forming (often flat) before the finished one, or an hour written twice where the clocks change. The row
 * with the widest range (high minus low) is kept, because a forming minute is always inside the finished one;
 * on a tie the first stays. The others are counted as `DUPLICATE`. A minute that comes behind a later one is put
 * in its place and counted in `reordered`.
 */
function importBars(files: readonly HistSource[], options: ImportOptions): ImportResult {
  const tally = new Tally();
  const kept = new Map<number, KeptBar>();
  let newest = Number.NEGATIVE_INFINITY;
  for (const file of files) {
    for (const { line, value: bar } of parsedLines(file, parseBarLine, tally)) {
      const entry: KeptBar = { ...bar, behind: bar.ts < newest, file: file.name, line };
      newest = Math.max(newest, bar.ts);
      const have = kept.get(bar.ts);
      if (have === undefined) {
        kept.set(bar.ts, entry);
        tally.accepted += 1;
        continue;
      }
      const winner = widthOf(entry) > widthOf(have) ? entry : have;
      const loser = winner === entry ? have : entry;
      kept.set(bar.ts, winner);
      tally.reject(loser.file, loser.line, 'DUPLICATE', barText(loser));
    }
  }
  const bars = [...kept.values()].sort((a, b) => a.ts - b.ts);
  const minutes = bars.map((bar) => midBar(bar, options.spreadAt(bar.ts)));
  const candles = aggregateMinutes(TRADED_SYMBOL, minutes).map(asBootstrap);
  const reordered = bars.filter((bar) => bar.behind).length;
  return { minutes, candles, report: reportOf('M1', files, tally, minutes, candles, reordered) };
}
function importTicks(files: readonly HistSource[]): ImportResult {
  const tally = new Tally();
  const builder = new CandleBuilder({ symbol: TRADED_SYMBOL });
  const built: MarketCandle[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const file of files) {
    for (const { line, text, value: tick } of parsedLines(file, parseTickLine, tally)) {
      const result = builder.push({
        ts: tick.ts,
        rxAt: tick.ts,
        symbol: TRADED_SYMBOL,
        bid: tick.bid,
        ask: tick.ask,
      });
      if (result.outcome === 'ACCEPTED') {
        tally.accepted += 1;
        last = Math.max(last, tick.ts);
        built.push(...result.closed);
      } else {
        tally.reject(
          file.name,
          line,
          result.outcome === 'LATE' ? 'OUT_OF_ORDER' : 'MALFORMED',
          text,
        );
      }
    }
  }
  if (Number.isFinite(last)) built.push(...builder.advanceTo(last + 2 * MINUTE_MS));
  const all = built.map(asBootstrap);
  const minutes = all.filter((candle) => candle.tf === '1m');
  const candles = all.filter((candle) => candle.tf !== '1m');
  return { minutes, candles, report: reportOf('TICK', files, tally, minutes, candles) };
}

/**
 * HistData files (in time order, all of one format) to 1m candles of mid prices and the higher
 * timeframes. Tick files carry bid and ask: the mid and the spread are the real ones and the
 * candles come from the same `CandleBuilder` as the live worker's. M1 files are bid only: the spread
 * model is added to get the mid, and the candles carry no spread. A bad line is counted and left
 * out, never fixed; the report says how many and shows the first ones.
 */
export function importHistData(files: readonly HistSource[], options: ImportOptions): ImportResult {
  const first = files[0];
  if (first === undefined) throw new RangeError('no files to import');
  const format = formatOf(first.name);
  for (const file of files) {
    if (formatOf(file.name) !== format) {
      throw new Error('one import takes one format: bars (_M1_) or ticks (_T_), not both');
    }
  }
  return format === 'M1' ? importBars(files, options) : importTicks(files);
}
