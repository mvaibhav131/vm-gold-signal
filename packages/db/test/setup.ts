import { inject } from 'vitest';

import { migrate } from '../src/migrate';
import { createTestDatabase, type TestDatabase } from './database';

/** A database of its own inside the shared test Postgres, with every migration applied. */
export async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase(inject('pgAdminUrl'));
  await migrate(database.url);
  return database;
}

/** A database of its own, still empty. */
export function emptyDatabase(): Promise<TestDatabase> {
  return createTestDatabase(inject('pgAdminUrl'));
}
