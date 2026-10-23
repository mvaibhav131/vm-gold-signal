import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DB } from './types.generated';

const DATE_OID: number = pg.types.builtins.DATE;

function parseColumn(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (oid === DATE_OID) return (value) => value;
  // pg types the oid as an enum (TypeId) although it hands out plain numbers.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
  return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
}

/**
 * A connection pool. `date` columns come back as `YYYY-MM-DD` strings: the driver's own parsing
 * would build a Date in the local time zone of the process, which shifts the day.
 */
export function createPool(connectionString: string, options: { max?: number } = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    types: { getTypeParser: parseColumn as typeof pg.types.getTypeParser },
  });
}

/** Typed query builder over a pool. The pool belongs to the caller, who ends it on shutdown. */
export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
