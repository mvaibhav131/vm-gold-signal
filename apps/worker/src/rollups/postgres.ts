import {
  RollupTables,
  type BucketRow,
  type CauseRow,
  type GroupRow,
  type LedgerTrade,
  type MonthlyRow,
  type RollupDelta,
  type RollupDifference,
  type RollupSignal,
  type SignalMode,
} from '@vmgs/core';
import type { Pool, PoolClient } from 'pg';

import type { RollupStore, RollupTx } from './reconcile';

type Db = Pick<PoolClient, 'query'>;
type Num = string | number;

const num = (value: Num): number => Number(value);

/** One rollup table: its key columns and its numbers, each as `[the field of the row, the column, its SQL type]`. */
interface Spec {
  readonly table: string;
  readonly keys: readonly (readonly [string, string, string])[];
  readonly values: readonly (readonly [string, string, string])[];
  /** The table has an `updated_at` that a write sets. */
  readonly touch: boolean;
}

const BUCKET: Spec = {
  table: 'stats_bucket',
  keys: [
    ['scope', 'scope', 'text'],
    ['level', 'level', 'smallint'],
    ['bucketKey', 'bucket_key', 'text'],
  ],
  values: [
    ['n', 'n', 'integer'],
    ['wins', 'wins', 'integer'],
    ['winners', 'winners', 'integer'],
    ['partials', 'partials', 'integer'],
    ['losses', 'losses', 'integer'],
    ['timeExits', 'time_exits', 'integer'],
    ['tp1Hits', 'tp1_hits', 'integer'],
    ['tp2Hits', 'tp2_hits', 'integer'],
    ['sumR', 'sum_r', 'numeric'],
    ['sumWinR', 'sum_win_r', 'numeric'],
    ['sumLossR', 'sum_loss_r', 'numeric'],
  ],
  touch: true,
};

const MONTHLY: Spec = {
  table: 'stats_monthly',
  keys: [
    ['month', 'month', 'date'],
    ['strategyKey', 'strategy_key', 'text'],
  ],
  values: [
    ['generated', 'generated', 'integer'],
    ['resolvedValid', 'resolved_valid', 'integer'],
    ['wins', 'wins', 'integer'],
    ['winners', 'winners', 'integer'],
    ['partials', 'partials', 'integer'],
    ['losses', 'losses', 'integer'],
    ['timeExits', 'time_exits', 'integer'],
    ['cancelled', 'cancelled', 'integer'],
    ['dataInvalid', 'data_invalid', 'integer'],
    ['netR', 'net_r', 'numeric'],
    ['sumWinR', 'sum_win_r', 'numeric'],
    ['sumLossR', 'sum_loss_r', 'numeric'],
  ],
  touch: false,
};

const GROUP: Spec = {
  table: 'evidence_group_stats',
  keys: [
    ['scope', 'scope', 'text'],
    ['strategyKey', 'strategy_key', 'text'],
    ['groupKey', 'group_key', 'text'],
    ['state', 'state', 'text'],
  ],
  values: [
    ['n', 'n', 'integer'],
    ['wins', 'wins', 'integer'],
    ['sumR', 'sum_r', 'numeric'],
  ],
  touch: false,
};

const CAUSE: Spec = {
  table: 'failure_cause_stats',
  keys: [
    ['month', 'month', 'date'],
    ['strategyKey', 'strategy_key', 'text'],
    ['causeCode', 'cause_code', 'text'],
  ],
  values: [
    ['n', 'n', 'integer'],
    ['sumR', 'sum_r', 'numeric'],
  ],
  touch: false,
};

type Field = readonly [string, string, string];
const columns = (fields: readonly Field[]): string => fields.map(([, column]) => column).join(', ');
const recordset = (fields: readonly Field[]): string =>
  fields.map(([, column, type]) => `${column} ${type}`).join(', ');

/** The rows as the JSON the statements read: the columns by name. */
function jsonOf(spec: Spec, rows: readonly object[]): string {
  const fields = [...spec.keys, ...spec.values];
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(
        fields.map(([key, column]) => [column, (row as Record<string, unknown>)[key]]),
      ),
    ),
  );
}

/** Writes rows: with `add` the numbers are added to those of the row of the same key, otherwise they replace them. */
async function write(
  db: Db,
  spec: Spec,
  rows: readonly object[],
  add: boolean,
  at: number,
): Promise<void> {
  if (rows.length === 0) return;
  const all = [...spec.keys, ...spec.values];
  const assignments = spec.values.map(([, column]) =>
    add ? `${column} = t.${column} + EXCLUDED.${column}` : `${column} = EXCLUDED.${column}`,
  );
  if (spec.touch) assignments.push('updated_at = EXCLUDED.updated_at');
  const stamp = spec.touch ? ', updated_at' : '';
  const stampValue = spec.touch ? ', $2::timestamptz' : '';
  await db.query(
    `INSERT INTO ${spec.table} AS t (${columns(all)}${stamp})
     SELECT ${all.map(([, column]) => `x.${column}`).join(', ')}${stampValue}
       FROM jsonb_to_recordset($1::jsonb) AS x(${recordset(all)})
     ON CONFLICT (${columns(spec.keys)}) DO UPDATE SET ${assignments.join(', ')}`,
    spec.touch ? [jsonOf(spec, rows), new Date(at)] : [jsonOf(spec, rows)],
  );
}

async function remove(
  db: Db,
  spec: Spec,
  rows: readonly object[],
  onlyZero = false,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `DELETE FROM ${spec.table} t USING jsonb_to_recordset($1::jsonb) AS x(${recordset(spec.keys)})
      WHERE ${spec.keys.map(([, column]) => `t.${column} = x.${column}`).join(' AND ')}${
        onlyZero ? ' AND t.n = 0' : ''
      }`,
    [jsonOf(spec, rows)],
  );
}

/**
 * Adds an event to the rollup tables, inside the transaction of the event (a signal that is created or closed, a
 * review that changes its cause). A cause that lost its last result is removed.
 */
export async function applyRollupDelta(db: Db, delta: RollupDelta, at: number): Promise<void> {
  await write(db, BUCKET, delta.buckets, true, at);
  await write(db, MONTHLY, delta.monthly, true, at);
  await write(db, GROUP, delta.groups, true, at);
  await write(db, CAUSE, delta.causes, true, at);
  await remove(
    db,
    CAUSE,
    delta.causes.filter((row) => row.n < 0),
    true,
  );
}

/** What the rollups need of a signal that was stored: its keys, and whether it is one of the live ones. */
export interface StoredRollupSignal {
  readonly mode: SignalMode;
  readonly signal: RollupSignal;
}

interface SignalFacts {
  mode: SignalMode;
  side: RollupSignal['side'];
  session: RollupSignal['session'];
  regime: RollupSignal['regime'];
  vol_bucket: RollupSignal['volBucket'];
  generated_at: Date;
  grouped_scores: {
    key: RollupSignal['groups'][number]['key'];
    state: RollupSignal['groups'][number]['state'];
  }[];
  strategy_key: RollupSignal['strategyKey'];
  version: string;
}

const signalOf = (row: SignalFacts): RollupSignal => ({
  strategyKey: row.strategy_key,
  version: row.version,
  side: row.side,
  session: row.session,
  regime: row.regime,
  volBucket: row.vol_bucket,
  generatedAt: row.generated_at.getTime(),
  groups: row.grouped_scores.map(({ key, state }) => ({ key, state })),
});

const FACTS = `s.mode, s.side, s.session, s.regime, s.vol_bucket, s.generated_at, s.grouped_scores,
       sv.strategy_key, sv.version`;

/** The keys a stored signal is filed under in the rollups. Null for a signal that is not there. */
export async function loadRollupSignal(
  db: Db,
  signalId: string,
): Promise<StoredRollupSignal | null> {
  const { rows } = await db.query<SignalFacts>(
    `SELECT ${FACTS} FROM signals s JOIN strategy_versions sv ON sv.id = s.strategy_version_id
      WHERE s.id = $1`,
    [signalId],
  );
  const row = rows[0];
  return row === undefined ? null : { mode: row.mode, signal: signalOf(row) };
}

interface BucketDb {
  scope: BucketRow['scope'];
  level: Num;
  bucket_key: string;
  n: Num;
  wins: Num;
  winners: Num;
  partials: Num;
  losses: Num;
  time_exits: Num;
  tp1_hits: Num;
  tp2_hits: Num;
  sum_r: Num;
  sum_win_r: Num;
  sum_loss_r: Num;
}

interface MonthlyDb {
  month: string;
  strategy_key: string;
  generated: Num;
  resolved_valid: Num;
  wins: Num;
  winners: Num;
  partials: Num;
  losses: Num;
  time_exits: Num;
  cancelled: Num;
  data_invalid: Num;
  net_r: Num;
  sum_win_r: Num;
  sum_loss_r: Num;
}

interface GroupDb {
  scope: GroupRow['scope'];
  strategy_key: string;
  group_key: GroupRow['groupKey'];
  state: GroupRow['state'];
  n: Num;
  wins: Num;
  sum_r: Num;
}

interface CauseDb {
  month: string;
  strategy_key: string;
  cause_code: CauseRow['causeCode'];
  n: Num;
  sum_r: Num;
}

async function storedRows(db: Db): Promise<RollupDelta> {
  // One after the other: `db` is the connection that holds the advisory lock, and pg@9 will refuse a second query on
  // a connection that is still busy with one.
  const buckets = await db.query<BucketDb>(
    `SELECT scope, level, bucket_key, n, wins, winners, partials, losses, time_exits, tp1_hits, tp2_hits,
            sum_r, sum_win_r, sum_loss_r
       FROM stats_bucket WHERE scope = 'FORWARD'`,
  );
  const monthly = await db.query<MonthlyDb>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, strategy_key, generated, resolved_valid, wins, winners,
            partials, losses, time_exits, cancelled, data_invalid, net_r, sum_win_r, sum_loss_r
       FROM stats_monthly`,
  );
  const groups = await db.query<GroupDb>(
    `SELECT scope, strategy_key, group_key, state, n, wins, sum_r
       FROM evidence_group_stats WHERE scope = 'FORWARD'`,
  );
  const causes = await db.query<CauseDb>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, strategy_key, cause_code, n, sum_r
       FROM failure_cause_stats`,
  );
  // sorted by key and without rows of zeros, as the pure tables give them
  return new RollupTables()
    .apply({
      buckets: buckets.rows.map((row) => ({
        scope: row.scope,
        level: num(row.level),
        bucketKey: row.bucket_key,
        n: num(row.n),
        wins: num(row.wins),
        winners: num(row.winners),
        partials: num(row.partials),
        losses: num(row.losses),
        timeExits: num(row.time_exits),
        tp1Hits: num(row.tp1_hits),
        tp2Hits: num(row.tp2_hits),
        sumR: num(row.sum_r),
        sumWinR: num(row.sum_win_r),
        sumLossR: num(row.sum_loss_r),
      })),
      monthly: monthly.rows.map((row): MonthlyRow => ({
        month: row.month,
        strategyKey: row.strategy_key,
        generated: num(row.generated),
        resolvedValid: num(row.resolved_valid),
        wins: num(row.wins),
        winners: num(row.winners),
        partials: num(row.partials),
        losses: num(row.losses),
        timeExits: num(row.time_exits),
        cancelled: num(row.cancelled),
        dataInvalid: num(row.data_invalid),
        netR: num(row.net_r),
        sumWinR: num(row.sum_win_r),
        sumLossR: num(row.sum_loss_r),
      })),
      groups: groups.rows.map((row) => ({
        scope: row.scope,
        strategyKey: row.strategy_key,
        groupKey: row.group_key,
        state: row.state,
        n: num(row.n),
        wins: num(row.wins),
        sumR: num(row.sum_r),
      })),
      causes: causes.rows.map((row) => ({
        month: row.month,
        strategyKey: row.strategy_key,
        causeCode: row.cause_code,
        n: num(row.n),
        sumR: num(row.sum_r),
      })),
    })
    .snapshot();
}

interface LedgerRow extends SignalFacts {
  result: string | null;
  counts_in_stats: boolean | null;
  closed_at: Date | null;
  realized_r_net: Num | null;
  duration_s: number | null;
  tp1_hit: boolean | null;
  tp2_hit: boolean | null;
  primary_cause: LedgerTrade['primaryCause'];
}

async function ledgerRows(db: Db): Promise<LedgerTrade[]> {
  const { rows } = await db.query<LedgerRow>(
    `SELECT ${FACTS}, o.result, o.counts_in_stats, o.closed_at, o.realized_r_net, o.duration_s,
            o.tp1_hit, o.tp2_hit, a.primary_cause
       FROM signals s
       JOIN strategy_versions sv ON sv.id = s.strategy_version_id
       LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       LEFT JOIN signal_autopsies a ON a.signal_id = s.id
      WHERE s.mode = 'LIVE'
      ORDER BY s.seq`,
  );
  return rows.map((row) => ({
    ...signalOf(row),
    outcome:
      row.result === null || row.closed_at === null
        ? null
        : {
            result: row.result as NonNullable<LedgerTrade['outcome']>['result'],
            countsInStats: row.counts_in_stats ?? false,
            realizedRNet: row.realized_r_net === null ? null : num(row.realized_r_net),
            durationS: row.duration_s ?? 0,
            tp1Hit: row.tp1_hit ?? false,
            tp2Hit: row.tp2_hit ?? false,
            closedAt: row.closed_at.getTime(),
          },
    primaryCause: row.primary_cause,
  }));
}

const TABLES: readonly [RollupDifference['table'], Spec][] = [
  ['stats_bucket', BUCKET],
  ['stats_monthly', MONTHLY],
  ['evidence_group_stats', GROUP],
  ['failure_cause_stats', CAUSE],
];

/** The rollup tables in PostgreSQL, for the nightly reconciliation (the transactions of the lifecycle write them with `applyRollupDelta`). */
export class PostgresRollupStore implements RollupStore {
  constructor(private readonly pool: Pool) {}

  async withLock<T>(work: (tx: RollupTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // a creating or closing transaction needs a row lock on these: it waits, or is waited for
      await client.query(
        'LOCK TABLE stats_bucket, stats_monthly, evidence_group_stats, failure_cause_stats IN SHARE ROW EXCLUSIVE MODE',
      );
      const result = await work({
        stored: () => storedRows(client),
        ledger: () => ledgerRows(client),
        replace: async (differences) => {
          const at = Date.now();
          for (const [table, spec] of TABLES) {
            const mine = differences.filter((item) => item.table === table);
            await write(
              client,
              spec,
              mine.flatMap((item) => (item.expected === null ? [] : [item.expected])),
              false,
              at,
            );
            await remove(
              client,
              spec,
              mine.flatMap((item) =>
                item.expected === null && item.stored !== null ? [item.stored] : [],
              ),
            );
          }
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
