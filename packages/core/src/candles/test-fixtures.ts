import type { MarketCandle, TickInput } from './types';

export const SYMBOL = 'XAUUSD';

export const utc = (iso: string): number => Date.parse(iso);

/** A tick with prices given as plain numbers; `rxAt` defaults to the source time. */
export function tick(iso: string | number, bid: number, ask: number, rxAt?: number): TickInput {
  const ts = typeof iso === 'number' ? iso : utc(iso);
  return { ts, rxAt: rxAt ?? ts, symbol: SYMBOL, bid, ask };
}

/** Small deterministic random generator, so fixtures are identical on every machine and run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface RandomTickOptions {
  readonly seed: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly startMidMilli?: number;
  /** Share of ticks that arrive 1 to 3 seconds late. */
  readonly lateShare?: number;
}

/**
 * A random walk of ticks with 1 s timestamp resolution like the real feed: 0 to 4 ticks per
 * second (2 on average; the live feed does about 2.4). Only integer arithmetic and `Math.round`,
 * no `Math.log`, so the stream is bit-identical on every platform and Node version.
 */
export function randomTicks(options: RandomTickOptions): TickInput[] {
  const random = mulberry32(options.seed);
  const lateShare = options.lateShare ?? 0;
  let mid = options.startMidMilli ?? 4_017_000;
  const ticks: TickInput[] = [];
  for (let second = options.fromMs; second < options.toMs; second += 1000) {
    const count = Math.floor(random() * 5);
    for (let i = 0; i < count; i += 1) {
      mid = Math.max(1_000, mid + Math.round((random() - 0.5) * 400));
      const spread = 100 + Math.floor(random() * 300);
      const bid = mid - Math.floor(spread / 2);
      const delay = random() < lateShare ? (1 + Math.floor(random() * 3)) * 1000 : 0;
      ticks.push({
        ts: second - delay,
        rxAt: second,
        symbol: SYMBOL,
        bid: bid / 1000,
        ask: (bid + spread) / 1000,
      });
    }
  }
  return ticks;
}

/** FNV-1a 64 bit over the UTF-16 code units: a stable fingerprint to pin a replay in a test. */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** A closed 1m candle for tests that feed the aggregator directly. */
export function minuteCandle(
  iso: string,
  prices: { o: number; h: number; l: number; c: number },
  extra: Partial<MarketCandle> = {},
): MarketCandle {
  return {
    symbol: SYMBOL,
    tf: '1m',
    openTime: utc(iso),
    ...prices,
    spreadAvg: 0.2,
    spreadMax: 0.3,
    tickCount: 10,
    complete: true,
    source: 'live',
    ...extra,
  };
}
