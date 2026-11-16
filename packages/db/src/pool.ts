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

export interface PoolOptions {
  max?: number;
  /**
   * The PEM text of the CA that signed the certificate of the database (a managed Postgres hands it out as `ca.pem`).
   * For a host where no file can be mounted for `NODE_EXTRA_CA_CERTS`. The connection is then TLS and verified against
   * this CA: TLS verification is never switched off (01_HLD section 8).
   */
  ca?: string | undefined;
}

/** A PEM kept in an environment variable on one line has `\n` for its line breaks. */
export function pemOf(text: string): string {
  return `${text.replaceAll('\\n', '\n').trim()}\n`;
}

/**
 * What `pg.Pool` gets for a URL. With a CA, the `sslmode` family of the URL is dropped (the URL a managed Postgres
 * gives ends in `?sslmode=require`, and the driver would let that override the options) and the connection is TLS
 * with the certificate checked against the CA and the host name checked as well.
 */
export function poolConfigOf(
  connectionString: string,
  options: PoolOptions = {},
): { connectionString: string; max: number; ssl?: { ca: string; rejectUnauthorized: true } } {
  const max = options.max ?? 10;
  if (options.ca === undefined) return { connectionString, max };
  const url = new URL(connectionString);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    max,
    ssl: { ca: pemOf(options.ca), rejectUnauthorized: true },
  };
}

/**
 * A connection pool. `date` columns come back as `YYYY-MM-DD` strings: the driver's own parsing
 * would build a Date in the local time zone of the process, which shifts the day.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    ...poolConfigOf(connectionString, options),
    types: { getTypeParser: parseColumn as typeof pg.types.getTypeParser },
  });
}

/** Typed query builder over a pool. The pool belongs to the caller, who ends it on shutdown. */
export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
