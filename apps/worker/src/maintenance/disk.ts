import type { DiskUsage } from './store';

/**
 * The hosts that mean "this machine" in a database address: the compose stack (`db`), a local Postgres, Docker Desktop. A
 * database at any other host (Aiven, another server) lives on a disk that this machine cannot see.
 */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  'db',
  'host.docker.internal',
]);

/**
 * Whether the disk of this machine says something about the database. It does only when the database is on this machine:
 * with a database at a host (the free Aiven plan) the size guard must not read the disk of the container the worker runs
 * in, which is shared with other things (on Render it was 83 percent full and the guard cut the days of ticks to one).
 */
export function databaseOnThisMachine(databaseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(databaseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** No disk is known: the size guard then only compares the size of the database with its limit. */
export class NoDisk implements DiskUsage {
  usage(): Promise<null> {
    return Promise.resolve(null);
  }
}
