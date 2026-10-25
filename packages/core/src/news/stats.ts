import { Atr } from '../indicators/volatility';
import { sessionAt } from '../time/sessions';
import type { NewsImpact, NewsTopic, Session } from '../domain';

const FIVE_MIN_MS = 300_000;
const MINUTE_MS = 60_000;

/** A candle of mid prices as the statistics need it. */
export interface StatCandle {
  readonly openTime: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** The ATR(14) of the candles in the order given (oldest first), null before 14 candles. */
export function atrOfCandles(candles: readonly StatCandle[], period = 14): number | null {
  const atr = new Atr(period);
  let value: number | null = null;
  for (const candle of candles) value = atr.update(candle);
  return value;
}

/**
 * ATR(14) of 5-minute candles as it was known at any moment: the value after the last candle that had
 * closed by then. Null before 14 candles have closed.
 */
export function atrLookup(
  candles5m: readonly StatCandle[],
  period = 14,
): (at: number) => number | null {
  const atr = new Atr(period);
  const closes: number[] = [];
  const values: (number | null)[] = [];
  for (const candle of [...candles5m].sort((a, b) => a.openTime - b.openTime)) {
    values.push(atr.update(candle));
    closes.push(candle.openTime + FIVE_MIN_MS);
  }
  return (at) => {
    let low = 0;
    let high = closes.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((closes[middle] ?? Infinity) <= at) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found < 0 ? null : (values[found] ?? null);
  };
}

/** What a headline cluster measured: a row of `news_impact_samples` as the statistics read it. */
export interface StatSample {
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
  readonly session: Session;
  readonly atr5: number;
  readonly move10m: number;
  readonly maxAbs10m: number;
}

/** A row of `news_topic_stats` (02 section 16): per topic and impact level. */
export interface TopicStat {
  readonly topic: NewsTopic;
  readonly impact: NewsImpact;
  readonly n: number;
  /** Samples whose largest excursion in 10 minutes was at least 1 x ATR(5m). */
  readonly moved1atr: number;
  readonly sumAbsAtr10m: number;
  readonly sumSignedAtr10m: number;
}

/**
 * The statistics of the samples by topic and impact, recomputed from scratch (the worker's SQL
 * gives the same numbers). A sample with two topics counts for both.
 */
export function topicStats(samples: readonly StatSample[]): TopicStat[] {
  const rows = new Map<string, { -readonly [K in keyof TopicStat]: TopicStat[K] }>();
  for (const sample of samples) {
    for (const topic of new Set(sample.topics)) {
      const key = `${topic}|${sample.impact}`;
      const row = rows.get(key) ?? {
        topic,
        impact: sample.impact,
        n: 0,
        moved1atr: 0,
        sumAbsAtr10m: 0,
        sumSignedAtr10m: 0,
      };
      row.n += 1;
      if (sample.maxAbs10m >= sample.atr5) row.moved1atr += 1;
      row.sumAbsAtr10m += Math.abs(sample.move10m) / sample.atr5;
      row.sumSignedAtr10m += sample.move10m / sample.atr5;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.topic.localeCompare(b.topic) || a.impact.localeCompare(b.impact),
  );
}

/** An ordinary window of 10 minutes (no headline and no big event near) and whether gold moved 1 ATR(5m) in it. */
export interface OrdinaryWindow {
  readonly session: Session;
  readonly moved: boolean;
}

/**
 * The windows of 10 minutes that start on a 5-minute boundary, are made of ten complete 1-minute
 * candles, have an ATR(5m) known at their start, and have none of `eventTimes` from `marginMs` before
 * their start to `marginMs` after it. Each says in which session it began and whether its largest
 * excursion from the first open reached 1 x ATR(5m): the same statistic as for a headline.
 */
export function ordinaryWindows(
  candles1m: readonly StatCandle[],
  atrAt: (at: number) => number | null,
  eventTimes: readonly number[],
  marginMs = 600_000,
): OrdinaryWindow[] {
  const byTime = new Map(candles1m.map((candle) => [candle.openTime, candle]));
  const events = [...eventTimes].sort((a, b) => a - b);
  const starts = new Set<number>();
  for (const candle of candles1m) {
    starts.add(Math.floor(candle.openTime / FIVE_MIN_MS) * FIVE_MIN_MS);
  }
  const windows: OrdinaryWindow[] = [];
  let pointer = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    while (pointer < events.length && (events[pointer] ?? Infinity) < start - marginMs)
      pointer += 1;
    const nearest = events[pointer];
    if (nearest !== undefined && nearest <= start + marginMs) continue;
    const first = byTime.get(start);
    const atr = atrAt(start);
    if (first === undefined || atr === null || !(atr > 0)) continue;
    let maxAbs = 0;
    let complete = true;
    for (let minute = 0; minute < 10; minute += 1) {
      const candle = byTime.get(start + minute * MINUTE_MS);
      if (candle === undefined) {
        complete = false;
        break;
      }
      maxAbs = Math.max(maxAbs, Math.abs(candle.h - first.o), Math.abs(candle.l - first.o));
    }
    if (complete) windows.push({ session: sessionAt(start), moved: maxAbs >= atr });
  }
  return windows;
}

export interface SessionShare {
  readonly windows: number;
  readonly moved: number;
}

/** How many ordinary windows began in each session and how many of them moved 1 ATR. */
export function sessionShares(
  windows: readonly OrdinaryWindow[],
): Partial<Record<Session, SessionShare>> {
  const shares: Partial<Record<Session, { windows: number; moved: number }>> = {};
  for (const window of windows) {
    const share = (shares[window.session] ??= { windows: 0, moved: 0 });
    share.windows += 1;
    if (window.moved) share.moved += 1;
  }
  return shares;
}

/**
 * The share of ordinary windows that moved 1 ATR, over the same sessions as the samples of a row:
 * the share of each session weighted by how many of the row's samples began in it. A session with no
 * ordinary window is left out of the weighting; null when none is left.
 */
export function baselineShare(
  sampleSessions: Partial<Record<Session, number>>,
  shares: Partial<Record<Session, SessionShare>>,
): number | null {
  let weighted = 0;
  let total = 0;
  for (const [session, count] of Object.entries(sampleSessions) as [Session, number][]) {
    const share = shares[session];
    if (share === undefined || share.windows === 0 || count <= 0) continue;
    weighted += count * (share.moved / share.windows);
    total += count;
  }
  return total === 0 ? null : weighted / total;
}
