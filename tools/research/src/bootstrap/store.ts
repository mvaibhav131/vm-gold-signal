import { TRADED_SYMBOL, type MarketCandle } from '@vmgs/core';
import type { Pool } from 'pg';

import type { HourSpread } from '../spread/model';

/** What the research tools read and write in the database. */
export interface BootstrapStore {
  /** Open time of the first live 1m candle, or null before the worker has recorded anything. */
  liveFrom(): Promise<number | null>;
  /** The recorded 5m spreads by UTC hour, since an instant. */
  spreadRows(since: number): Promise<HourSpread[]>;
  /** Writes candles that are not in the table yet; returns how many were new. */
  write(candles: readonly MarketCandle[]): Promise<number>;
}

const ROWS_PER_INSERT = 1_000;
const COLUMNS = 12;

const placeholders = (row: number): string =>
  `(${Array.from({ length: COLUMNS }, (_, column) => `$${String(row * COLUMNS + column + 1)}`).join(', ')})`;

/**
 * The tables with the rights of the `vmgs_worker` role. History is written with `ON CONFLICT DO
 * NOTHING`: a candle that is already there, live or from an earlier import, is never touched.
 */
export class PostgresBootstrapStore implements BootstrapStore {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string = TRADED_SYMBOL,
  ) {}

  async liveFrom(): Promise<number | null> {
    const { rows } = await this.pool.query<{ first: Date | null }>(
      "SELECT min(open_time) AS first FROM candles WHERE symbol = $1 AND tf = '1m' AND source = 'live'",
      [this.symbol],
    );
    return rows[0]?.first?.getTime() ?? null;
  }

  async spreadRows(since: number): Promise<HourSpread[]> {
    const { rows } = await this.pool.query<{
      hour: number;
      median: number;
      p90: number;
      n: number;
    }>(
      `SELECT extract(hour FROM open_time AT TIME ZONE 'UTC')::int AS hour,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY spread_avg::float8) AS median,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY spread_avg::float8) AS p90,
              count(*)::int AS n
         FROM candles
        WHERE symbol = $1 AND tf = '5m' AND source = 'live'
          AND spread_avg IS NOT NULL AND open_time >= $2
        GROUP BY 1 ORDER BY 1`,
      [this.symbol, new Date(since)],
    );
    return rows;
  }

  async write(candles: readonly MarketCandle[]): Promise<number> {
    let added = 0;
    for (let start = 0; start < candles.length; start += ROWS_PER_INSERT) {
      const chunk = candles.slice(start, start + ROWS_PER_INSERT);
      const values = chunk.flatMap((candle) => [
        candle.symbol,
        candle.tf,
        new Date(candle.openTime),
        candle.o,
        candle.h,
        candle.l,
        candle.c,
        candle.spreadAvg,
        candle.spreadMax,
        candle.tickCount,
        candle.complete,
        candle.source,
      ]);
      const result = await this.pool.query(
        `INSERT INTO candles
           (symbol, tf, open_time, o, h, l, c, spread_avg, spread_max, tick_count, complete, source)
         VALUES ${chunk.map((_, row) => placeholders(row)).join(', ')}
         ON CONFLICT (symbol, tf, open_time) DO NOTHING`,
        values,
      );
      added += result.rowCount ?? 0;
    }
    return added;
  }
}
