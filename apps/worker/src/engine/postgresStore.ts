import {
  STRATEGY_ENABLED_KEY,
  engineStateSchema,
  settingsSchema,
  strategyEnabledSchema,
} from '@vmgs/contracts';
import {
  BUCKET_LEVELS,
  ENGINE_STATE_KEY,
  STRATEGY_KEYS,
  TRADED_SYMBOL,
  bucketKeys,
  isPaused,
  pickEvidence,
  tradingDayStart,
  type AdvisoryModes,
  type BucketCounts,
  type BucketDims,
  type EngineCandle,
  type EngineStateDoc,
  type EngineTimeframe,
  type ExplanationEvidence,
  type Rejection,
  type ScopeBuckets,
  type StatsScope,
  type StoredEngine,
} from '@vmgs/core';
import type { Pool } from 'pg';

import type {
  CandleCursor,
  EngineControls,
  EngineStore,
  OpenSignalFacts,
  StoredCandle,
  StoredQuote,
} from './store';

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`database returned an invalid number: ${String(value)}`);
  }
  return result;
};

export { ENGINE_STATE_KEY };

const TIMEFRAMES: readonly EngineTimeframe[] = ['5m', '15m', '1h'];
const SCOPES: readonly StatsScope[] = ['FORWARD', 'BACKTEST_OOS'];

interface CandleRow {
  tf: EngineTimeframe;
  open_time: Date;
  o: Num;
  h: Num;
  l: Num;
  c: Num;
  spread_avg: Num | null;
}

const candleOf = (row: CandleRow): StoredCandle => ({
  tf: row.tf,
  candle: {
    openTime: row.open_time.getTime(),
    o: num(row.o),
    h: num(row.h),
    l: num(row.l),
    c: num(row.c),
    spread: row.spread_avg === null ? null : num(row.spread_avg),
  } satisfies EngineCandle,
});

/**
 * What the decision loop reads and writes in PostgreSQL, with the rights of the worker role: the closed candles of the
 * traded symbol, the first quote after a close, the owner's pause and switches, the open signals, the rollups behind the
 * evidence, the `rejections` table and the engine state in `app_settings`.
 */
export class PostgresEngineStore implements EngineStore {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  async history(limits: Readonly<Record<EngineTimeframe, number>>): Promise<StoredCandle[]> {
    const found: StoredCandle[] = [];
    for (const tf of TIMEFRAMES) {
      const { rows } = await this.pool.query<CandleRow>(
        `SELECT tf, open_time, o, h, l, c, spread_avg FROM candles
          WHERE symbol = $1 AND tf = $2 AND complete
          ORDER BY open_time DESC LIMIT $3`,
        [this.symbol, tf, limits[tf]],
      );
      found.push(...rows.reverse().map(candleOf));
    }
    return found;
  }

  async after(cursor: CandleCursor, limit: number): Promise<StoredCandle[]> {
    const from = (tf: EngineTimeframe): Date => new Date(cursor[tf] ?? 0);
    const { rows } = await this.pool.query<CandleRow>(
      `SELECT tf, open_time, o, h, l, c, spread_avg FROM candles
        WHERE symbol = $1 AND complete
          AND ((tf = '5m' AND open_time > $2)
            OR (tf = '15m' AND open_time > $3)
            OR (tf = '1h' AND open_time > $4))
        ORDER BY open_time, tf LIMIT $5`,
      [this.symbol, from('5m'), from('15m'), from('1h'), limit],
    );
    return rows.map(candleOf);
  }

  async firstQuoteAtOrAfter(ts: number): Promise<StoredQuote | null> {
    const { rows } = await this.pool.query<{ ts: Date; rx_at: Date; bid: Num; ask: Num }>(
      `SELECT ts, rx_at, bid, ask FROM ticks
        WHERE symbol = $1 AND ts >= $2
        ORDER BY ts, rx_at LIMIT 1`,
      [this.symbol, new Date(ts)],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { t: row.ts.getTime(), rxAt: row.rx_at.getTime(), bid: num(row.bid), ask: num(row.ask) };
  }

  async controls(now: number): Promise<EngineControls> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
      [['engine', 'advisoryGates', STRATEGY_ENABLED_KEY]],
    );
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const engine = stored.get('engine');
    let paused = false;
    if (engine !== undefined) {
      const state = engineStateSchema.parse(engine);
      const asStored: StoredEngine =
        state.status === 'RUNNING'
          ? { status: 'RUNNING' }
          : {
              status: 'PAUSED',
              since: Date.parse(state.pausedSince),
              until: state.pausedUntil === null ? null : Date.parse(state.pausedUntil),
            };
      paused = isPaused(asStored, now);
    }
    const gates = stored.get('advisoryGates');
    const modes: Partial<AdvisoryModes> =
      gates === undefined ? {} : settingsSchema.shape.advisoryGates.parse(gates);
    const switches = stored.get(STRATEGY_ENABLED_KEY);
    const enabled = switches === undefined ? {} : strategyEnabledSchema.parse(switches);
    const disabled = STRATEGY_KEYS.filter((key) => enabled[key] === false);
    return { paused, modes, disabled };
  }

  async openSignals(): Promise<OpenSignalFacts[]> {
    const { rows } = await this.pool.query<{
      id: string;
      seq: Num;
      side: 'BUY' | 'SELL';
      status: 'ACTIVE' | 'TP1_HIT';
    }>(
      `SELECT s.id, s.seq, s.side, st.status
         FROM signals s JOIN signal_state st ON st.signal_id = s.id
        WHERE s.mode = 'LIVE'
        ORDER BY s.seq`,
    );
    return rows.map((row) => ({
      id: row.id,
      side: row.side,
      riskR: row.status === 'TP1_HIT' ? 0 : 1,
      label: `#S-${String(num(row.seq)).padStart(4, '0')}`,
    }));
  }

  async dayResultR(now: number): Promise<number> {
    const { rows } = await this.pool.query<{ total: Num }>(
      `SELECT COALESCE(SUM(o.realized_r_net), 0) AS total
         FROM signal_outcomes o JOIN signals s ON s.id = o.signal_id
        WHERE s.mode = 'LIVE' AND o.counts_in_stats
          AND o.closed_at >= $1 AND o.closed_at <= $2`,
      [new Date(tradingDayStart(now)).toISOString(), new Date(now).toISOString()],
    );
    return num(rows[0]?.total ?? 0);
  }

  async evidence(dims: BucketDims): Promise<ExplanationEvidence> {
    const keys = bucketKeys(dims);
    const { rows } = await this.pool.query<{
      scope: StatsScope;
      level: number;
      bucket_key: string;
      n: number;
      wins: number;
      winners: number;
      partials: number;
      losses: number;
      time_exits: number;
      tp1_hits: number;
      tp2_hits: number;
      sum_r: Num;
      sum_win_r: Num;
      sum_loss_r: Num;
    }>(
      `SELECT scope, level, bucket_key, n, wins, winners, partials, losses, time_exits, tp1_hits,
              tp2_hits, sum_r, sum_win_r, sum_loss_r
         FROM stats_bucket
        WHERE bucket_key = ANY($1::text[]) AND scope = ANY($2::text[])`,
      [keys, [...SCOPES]],
    );
    const byScope: Record<StatsScope, (BucketCounts | null)[]> = {
      FORWARD: Array.from({ length: BUCKET_LEVELS }, () => null),
      BACKTEST_OOS: Array.from({ length: BUCKET_LEVELS }, () => null),
    };
    for (const row of rows) {
      if (keys[row.level] !== row.bucket_key) continue;
      byScope[row.scope][row.level] = {
        n: row.n,
        wins: row.wins,
        winners: row.winners,
        partials: row.partials,
        losses: row.losses,
        timeExits: row.time_exits,
        tp1Hits: row.tp1_hits,
        tp2Hits: row.tp2_hits,
        sumR: num(row.sum_r),
        sumWinR: num(row.sum_win_r),
        sumLossR: num(row.sum_loss_r),
      };
    }
    const scoped = (scope: StatsScope): ScopeBuckets => byScope[scope];
    return pickEvidence({ FORWARD: scoped('FORWARD'), BACKTEST_OOS: scoped('BACKTEST_OOS') });
  }

  async recordRejection(at: number, rejection: Rejection): Promise<void> {
    await this.pool.query(
      `INSERT INTO rejections (at, strategy_key, side, failed_gates, quality_score, detail)
       VALUES ($1, $2, $3, $4::text[], $5, $6::jsonb)`,
      [
        new Date(at),
        rejection.strategyKey,
        rejection.side,
        [...rejection.codes],
        rejection.qualityScore,
        JSON.stringify({ setupKey: rejection.setupKey, ...rejection.detail }),
      ],
    );
  }

  async saveState(state: EngineStateDoc, at: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [ENGINE_STATE_KEY, JSON.stringify(state), new Date(at)],
    );
  }
}
