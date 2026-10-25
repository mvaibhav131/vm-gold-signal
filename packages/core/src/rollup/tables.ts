import { closedDelta, createdDelta } from './delta';
import type { StatsScope } from '../domain';
import type { BucketRow, CauseRow, GroupRow, LedgerTrade, MonthlyRow, RollupDelta } from './types';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const BUCKET_FIELDS = [
  'n',
  'wins',
  'winners',
  'partials',
  'losses',
  'timeExits',
  'tp1Hits',
  'tp2Hits',
  'sumR',
  'sumWinR',
  'sumLossR',
] as const satisfies readonly (keyof BucketRow)[];

const MONTHLY_FIELDS = [
  'generated',
  'resolvedValid',
  'wins',
  'winners',
  'partials',
  'losses',
  'timeExits',
  'cancelled',
  'dataInvalid',
  'netR',
  'sumWinR',
  'sumLossR',
] as const satisfies readonly (keyof MonthlyRow)[];

const GROUP_FIELDS = ['n', 'wins', 'sumR'] as const satisfies readonly (keyof GroupRow)[];
const CAUSE_FIELDS = ['n', 'sumR'] as const satisfies readonly (keyof CauseRow)[];

export const bucketId = (row: Pick<BucketRow, 'scope' | 'level' | 'bucketKey'>): string =>
  `${row.scope}|${String(row.level)}|${row.bucketKey}`;
export const monthlyId = (row: Pick<MonthlyRow, 'month' | 'strategyKey'>): string =>
  `${row.month}|${row.strategyKey}`;
export const groupId = (
  row: Pick<GroupRow, 'scope' | 'strategyKey' | 'groupKey' | 'state'>,
): string => `${row.scope}|${row.strategyKey}|${row.groupKey}|${row.state}`;
export const causeId = (row: Pick<CauseRow, 'month' | 'strategyKey' | 'causeCode'>): string =>
  `${row.month}|${row.strategyKey}|${row.causeCode}`;

/** Adds the numbers of `row` to the row of the same key (a row that is new is kept as it is). */
function merge<T extends object>(
  rows: Map<string, T>,
  id: string,
  row: T,
  fields: readonly (keyof T & string)[],
): void {
  const held = rows.get(id);
  if (held === undefined) {
    rows.set(id, { ...row });
    return;
  }
  const next = { ...held } as Record<string, unknown>;
  for (const field of fields) next[field] = round3(Number(held[field]) + Number(row[field]));
  rows.set(id, next as T);
}

const isEmpty = <T extends object>(row: T, fields: readonly (keyof T & string)[]): boolean =>
  fields.every((field) => Number(row[field]) === 0);

const sorted = <T extends object>(
  rows: Map<string, T>,
  fields: readonly (keyof T & string)[],
): T[] =>
  [...rows.entries()]
    .filter(([, row]) => !isEmpty(row, fields))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);

/**
 * The four rollup tables in memory. `apply` adds an event to them; `snapshot` gives their rows, sorted, without
 * the rows that have gone back to zero (a cause that lost its last result is not a row). Numbers have three decimals
 * (the net R of a trade has three), so adding in any order gives the same table.
 */
export class RollupTables {
  private readonly buckets = new Map<string, BucketRow>();
  private readonly monthly = new Map<string, MonthlyRow>();
  private readonly groups = new Map<string, GroupRow>();
  private readonly causes = new Map<string, CauseRow>();

  apply(delta: RollupDelta): this {
    for (const row of delta.buckets) merge(this.buckets, bucketId(row), row, BUCKET_FIELDS);
    for (const row of delta.monthly) merge(this.monthly, monthlyId(row), row, MONTHLY_FIELDS);
    for (const row of delta.groups) merge(this.groups, groupId(row), row, GROUP_FIELDS);
    for (const row of delta.causes) merge(this.causes, causeId(row), row, CAUSE_FIELDS);
    return this;
  }

  snapshot(): RollupDelta {
    return {
      buckets: sorted(this.buckets, BUCKET_FIELDS),
      monthly: sorted(this.monthly, MONTHLY_FIELDS),
      groups: sorted(this.groups, GROUP_FIELDS),
      causes: sorted(this.causes, CAUSE_FIELDS),
    };
  }
}

/**
 * The tables as a full recomputation from the signals gives them: every signal is one `generated`, every
 * closed one is added as its closing adds it. The nightly reconciliation holds the stored tables to this.
 */
export function rollupsOfTrades(
  trades: Iterable<LedgerTrade>,
  scope: StatsScope = 'FORWARD',
): RollupDelta {
  const tables = new RollupTables();
  for (const trade of trades) {
    tables.apply(createdDelta(trade));
    if (trade.outcome !== null)
      tables.apply(closedDelta({ ...trade, outcome: trade.outcome }, scope));
  }
  return tables.snapshot();
}

export type RollupTable =
  'stats_bucket' | 'stats_monthly' | 'evidence_group_stats' | 'failure_cause_stats';

/** One row that the stored tables and the recomputation do not agree on (null: the table has no such row, or a row of zeros). */
export interface RollupDifference {
  readonly table: RollupTable;
  readonly key: string;
  readonly stored: BucketRow | MonthlyRow | GroupRow | CauseRow | null;
  readonly expected: BucketRow | MonthlyRow | GroupRow | CauseRow | null;
}

function differences<T extends object>(
  table: RollupTable,
  stored: readonly T[],
  expected: readonly T[],
  idOf: (row: T) => string,
  fields: readonly (keyof T & string)[],
): RollupDifference[] {
  const left = new Map(stored.map((row) => [idOf(row), row]));
  const right = new Map(expected.map((row) => [idOf(row), row]));
  const result: RollupDifference[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key) ?? null;
    const b = right.get(key) ?? null;
    const same =
      a !== null &&
      b !== null &&
      fields.every((field) => Math.abs(Number(a[field]) - Number(b[field])) < 0.0005);
    if (!same) {
      result.push({
        table,
        key,
        stored: a as RollupDifference['stored'],
        expected: b as RollupDifference['expected'],
      });
    }
  }
  return result.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** The rows in which the stored tables differ from the recomputed ones, by table and key. Empty when they agree. */
export function diffRollups(stored: RollupDelta, expected: RollupDelta): RollupDifference[] {
  const normal = (delta: RollupDelta): RollupDelta => new RollupTables().apply(delta).snapshot();
  const a = normal(stored);
  const b = normal(expected);
  return [
    ...differences('stats_bucket', a.buckets, b.buckets, bucketId, BUCKET_FIELDS),
    ...differences('stats_monthly', a.monthly, b.monthly, monthlyId, MONTHLY_FIELDS),
    ...differences('evidence_group_stats', a.groups, b.groups, groupId, GROUP_FIELDS),
    ...differences('failure_cause_stats', a.causes, b.causes, causeId, CAUSE_FIELDS),
  ];
}

/**
 * What was added between two readings of the tables: the rows of `after` less those of `before`, without the rows
 * that did not change. (A test that shares a database with others reads the tables before and after its own events.)
 */
export function subtractRollups(after: RollupDelta, before: RollupDelta): RollupDelta {
  const minus = <T extends object>(
    rows: readonly T[],
    fields: readonly (keyof T & string)[],
  ): T[] =>
    rows.map((row) => {
      const negated = { ...row } as Record<string, unknown>;
      for (const field of fields) negated[field] = -Number(row[field]);
      return negated as T;
    });
  return new RollupTables()
    .apply(after)
    .apply({
      buckets: minus(before.buckets, BUCKET_FIELDS),
      monthly: minus(before.monthly, MONTHLY_FIELDS),
      groups: minus(before.groups, GROUP_FIELDS),
      causes: minus(before.causes, CAUSE_FIELDS),
    })
    .snapshot();
}

/**
 * The stored tables after the differing rows were made what the recomputation says: a row that should be there is
 * written, a row that should not be there is dropped. The tables of `diffRollups(stored, expected)` repaired this way
 * are `expected`.
 */
export function repairRollups(
  stored: RollupDelta,
  differing: readonly RollupDifference[],
): RollupDelta {
  const repaired = <T extends object>(
    rows: readonly T[],
    table: RollupTable,
    idOf: (row: T) => string,
  ): T[] => {
    const mine = differing.filter((item) => item.table === table);
    const ids = new Set(mine.map((item) => item.key));
    return [
      ...rows.filter((row) => !ids.has(idOf(row))),
      ...mine.flatMap((item) => (item.expected === null ? [] : [item.expected as unknown as T])),
    ];
  };
  return {
    buckets: repaired(stored.buckets, 'stats_bucket', bucketId),
    monthly: repaired(stored.monthly, 'stats_monthly', monthlyId),
    groups: repaired(stored.groups, 'evidence_group_stats', groupId),
    causes: repaired(stored.causes, 'failure_cause_stats', causeId),
  };
}
