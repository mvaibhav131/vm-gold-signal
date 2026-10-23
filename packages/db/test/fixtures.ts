import { query } from './database';

/** Marks a value that goes into a json or jsonb column (plain arrays go to Postgres arrays). */
export class Json {
  readonly value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }
}

export type Row = Record<string, unknown>;

/** `INSERT ... RETURNING *` for one row; the keys are column names. */
export function buildInsert(table: string, row: Row): { sql: string; values: unknown[] } {
  const columns = Object.keys(row);
  const values = columns.map((column) => {
    const value = row[column];
    return value instanceof Json ? JSON.stringify(value.value) : value;
  });
  const placeholders = columns.map((column, index) =>
    row[column] instanceof Json ? `$${String(index + 1)}::jsonb` : `$${String(index + 1)}`,
  );
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  };
}

export async function insert(url: string, table: string, row: Row): Promise<Row> {
  const { sql, values } = buildInsert(table, row);
  const rows = await query(url, sql, values);
  const inserted = rows[0];
  if (inserted === undefined) throw new Error(`insert into ${table} returned no row`);
  return inserted;
}

export const STRATEGY_ID = '8b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e11';

export function strategyVersionRow(overrides: Row = {}): Row {
  return {
    id: STRATEGY_ID,
    strategy_key: 'trend_pullback',
    version: '0.1.0',
    config: new Json({ strategyKey: 'trend_pullback', version: '0.1.0' }),
    config_hash: 'a'.repeat(64),
    ...overrides,
  };
}

/** A valid BUY signal (02_Signal_Engine section 14); pass overrides to break one rule at a time. */
export function signalRow(overrides: Row = {}): Row {
  return {
    side: 'BUY',
    strategy_version_id: STRATEGY_ID,
    exit_profile: 'EP1_PARTIAL',
    mode: 'LIVE',
    generated_at: '2026-10-23T06:10:00Z',
    source_at: '2026-10-23T06:10:00Z',
    entry: '4017.370',
    max_valid_entry: '4017.550',
    entry_valid_until: '2026-10-23T06:13:00Z',
    stop_loss: '4010.900',
    tp1: '4023.840',
    tp2: '4030.310',
    risk_distance: '6.470',
    atr5: '4.300',
    time_stop_at: '2026-10-23T08:10:00Z',
    regime: 'TREND_UP',
    session: 'LONDON',
    vol_bucket: 'NORMAL',
    news_state: 'CLEAR',
    setup_key: 'pullback-leg-1',
    quality_score: '78',
    grouped_scores: new Json([]),
    hard_gates: new Json([]),
    feature_snapshot: new Json({ rsi14: 54.1 }),
    explanation: new Json({ headline: 'BUY XAUUSD' }),
    evidence: new Json({ winRate: 0.58, n: 64 }),
    ...overrides,
  };
}

export function outcomeRow(signalId: string, overrides: Row = {}): Row {
  return {
    signal_id: signalId,
    result: 'WIN',
    counts_in_stats: true,
    closed_at: '2026-10-23T06:50:00Z',
    exit_price: '4030.310',
    exit_reason: 'TP2',
    realized_r_gross: '1.500',
    cost_r: '0.030',
    realized_r_net: '1.470',
    duration_s: 2400,
    mfe_r: '2.100',
    mae_r: '-0.400',
    tp1_hit: true,
    tp2_hit: true,
    ...overrides,
  };
}

/** The first column of the first row. */
export async function scalar<T = unknown>(
  url: string,
  sql: string,
  values: unknown[] = [],
): Promise<T> {
  const rows = await query(url, sql, values);
  const first = rows[0];
  if (first === undefined) throw new Error(`no row for: ${sql}`);
  return Object.values(first)[0] as T;
}
