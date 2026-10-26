import type { Pool } from 'pg';

import { WORKER_HEARTBEAT } from '@vmgs/db';
import { ENGINE_STATE_KEY, TRADED_SYMBOL } from '@vmgs/core';
import type { Timeframe } from '@vmgs/core';

/** The newest tick of the traded symbol. */
export interface LatestQuote {
  readonly sourceAt: number;
  readonly receivedAt: number;
  readonly bid: number;
  readonly ask: number;
}

/** What the worker said about itself in its last heartbeat. */
export interface WorkerFacts {
  readonly heartbeatAt: number | null;
  /** `biquote` for the live feed, `replay` for a recorded one (then the signals are SIMULATED). */
  readonly provider: string | null;
  /** The state the feed monitor reported (`recorder.feedState` of the heartbeat). */
  readonly feedState: string | null;
}

/** Everything `GET /market/snapshot` is made of, as the database holds it (the documents are read defensively later). */
export interface MarketFacts {
  readonly quote: LatestQuote | null;
  readonly worker: WorkerFacts;
  /** `app_settings.engine`: the owner's pause. */
  readonly engineDoc: unknown;
  /** `app_settings.engineState`: what the decision loop said after its last decision. */
  readonly engineStateDoc: unknown;
  /** The signals that are open now (`ACTIVE` and `TP1_HIT`). */
  readonly openStatuses: readonly ('ACTIVE' | 'TP1_HIT')[];
}

export interface StoredCandle {
  readonly openTime: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

export interface MarketReader {
  facts(now: number): Promise<MarketFacts>;
  /**
   * The newest `count` complete candles of `tf` that opened before `before` (all of them when it is null), oldest
   * first. The overlays need more of them than are shown (`count` is the shown ones plus the warm-up).
   */
  candles(tf: Timeframe, count: number, before: number | null): Promise<StoredCandle[]>;
}

/** A quote older than this is not "the market now" for a chart or a dashboard: it is looked for no further back. */
const QUOTE_LOOKBACK_MS = 10 * 86_400_000;

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`the database returned an invalid number: ${String(value)}`);
  return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `app_settings.engineState`, as the decision loop saves it; the key is the worker's (`ENGINE_STATE_KEY`). */
export { ENGINE_STATE_KEY };

export class PostgresMarketReader implements MarketReader {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  async facts(now: number): Promise<MarketFacts> {
    const [quote, beat, settings, open] = await Promise.all([
      this.pool.query<{ ts: Date; rx_at: Date; bid: Num; ask: Num }>(
        `SELECT ts, rx_at, bid, ask FROM ticks
          WHERE symbol = $1 AND ts >= $2
          ORDER BY ts DESC, rx_at DESC LIMIT 1`,
        [this.symbol, new Date(now - QUOTE_LOOKBACK_MS)],
      ),
      this.pool.query<{ heartbeat_at: Date; metadata: unknown }>(
        'SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE worker_name = $1',
        [WORKER_HEARTBEAT],
      ),
      this.pool.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
        [['engine', ENGINE_STATE_KEY]],
      ),
      this.pool.query<{ status: 'ACTIVE' | 'TP1_HIT' }>(
        `SELECT st.status FROM signal_state st JOIN signals s ON s.id = st.signal_id
          WHERE s.mode <> 'BACKTEST' AND st.status IN ('ACTIVE', 'TP1_HIT')`,
      ),
    ]);
    const tick = quote.rows[0];
    const heartbeat = beat.rows[0];
    const metadata = heartbeat?.metadata;
    const recorder = isRecord(metadata) && isRecord(metadata.recorder) ? metadata.recorder : null;
    const stored = new Map(settings.rows.map((row) => [row.key, row.value]));
    return {
      quote:
        tick === undefined
          ? null
          : {
              sourceAt: tick.ts.getTime(),
              receivedAt: tick.rx_at.getTime(),
              bid: num(tick.bid),
              ask: num(tick.ask),
            },
      worker: {
        heartbeatAt: heartbeat?.heartbeat_at.getTime() ?? null,
        provider:
          isRecord(metadata) && typeof metadata.provider === 'string' ? metadata.provider : null,
        feedState:
          recorder !== null && typeof recorder.feedState === 'string' ? recorder.feedState : null,
      },
      engineDoc: stored.get('engine') ?? null,
      engineStateDoc: stored.get(ENGINE_STATE_KEY) ?? null,
      openStatuses: open.rows.map((row) => row.status),
    };
  }

  async candles(tf: Timeframe, count: number, before: number | null): Promise<StoredCandle[]> {
    const { rows } = await this.pool.query<{ open_time: Date; o: Num; h: Num; l: Num; c: Num }>(
      `SELECT open_time, o, h, l, c FROM candles
        WHERE symbol = $1 AND tf = $2 AND complete AND ($3::timestamptz IS NULL OR open_time < $3)
        ORDER BY open_time DESC LIMIT $4`,
      [this.symbol, tf, before === null ? null : new Date(before), count],
    );
    return rows
      .map((row) => ({
        openTime: row.open_time.getTime(),
        o: num(row.o),
        h: num(row.h),
        l: num(row.l),
        c: num(row.c),
      }))
      .reverse();
  }
}
