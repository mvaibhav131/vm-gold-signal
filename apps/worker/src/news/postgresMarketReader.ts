import type { StatCandle, TickPoint } from '@vmgs/core';
import type { Pool } from 'pg';

import type { MarketReader } from './store';

type Num = string | number;

const DURATION_SQL: Readonly<Record<'1m' | '5m', string>> = {
  '1m': '1 minute',
  '5m': '5 minutes',
};

/** The stored ticks and complete candles of the traded symbol, read for the move detector, the impact samples and the baseline. */
export class PostgresMarketReader implements MarketReader {
  constructor(
    private readonly pool: Pool,
    private readonly symbol: string,
  ) {}

  async ticks(from: number, until: number): Promise<TickPoint[]> {
    const { rows } = await this.pool.query<{ ts: Date; bid: Num; ask: Num }>(
      `SELECT ts, bid, ask FROM ticks
        WHERE symbol = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts, rx_at`,
      [this.symbol, new Date(from), new Date(until)],
    );
    return rows.map((row) => ({
      ts: row.ts.getTime(),
      bid: Number(row.bid),
      ask: Number(row.ask),
    }));
  }

  async closedCandles(tf: '1m' | '5m', until: number, limit: number): Promise<StatCandle[]> {
    const { rows } = await this.pool.query<CandleRow>(
      `SELECT open_time, o, h, l, c FROM candles
        WHERE symbol = $1 AND tf = $2 AND complete AND open_time + interval '${DURATION_SQL[tf]}' <= $3
        ORDER BY open_time DESC LIMIT $4`,
      [this.symbol, tf, new Date(until), limit],
    );
    return rows.map(candle).reverse();
  }

  async candlesBetween(tf: '1m' | '5m', from: number, until: number): Promise<StatCandle[]> {
    const { rows } = await this.pool.query<CandleRow>(
      `SELECT open_time, o, h, l, c FROM candles
        WHERE symbol = $1 AND tf = $2 AND complete AND open_time >= $3 AND open_time < $4
        ORDER BY open_time`,
      [this.symbol, tf, new Date(from), new Date(until)],
    );
    return rows.map(candle);
  }
}

interface CandleRow {
  open_time: Date;
  o: Num;
  h: Num;
  l: Num;
  c: Num;
}

const candle = (row: CandleRow): StatCandle => ({
  openTime: row.open_time.getTime(),
  o: Number(row.o),
  h: Number(row.h),
  l: Number(row.l),
  c: Number(row.c),
});
