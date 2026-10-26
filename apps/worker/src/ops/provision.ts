import type { AdminEnv } from '@vmgs/config';
import { createPool, migrate, type MigrateResult } from '@vmgs/db';

/** The roles of the schema and the variable that holds the password of each (06 section 3). */
export const ROLE_PASSWORD_VARS = [
  ['vmgs_worker', 'DB_PASSWORD_WORKER'],
  ['vmgs_api', 'DB_PASSWORD_API'],
  ['vmgs_backup', 'DB_PASSWORD_BACKUP'],
] as const;

export interface ProvisionResult extends MigrateResult {
  /** The roles that were given a password (names only). */
  roles: string[];
}

/**
 * The deploy step on the database: applies the pending migrations (forward only), then lets each application role
 * log in with the password of the root-owned `.env` (the migrations create the roles without a login, so no secret
 * lives in git). Running it again is harmless and is also how a password is rotated.
 */
export async function provision(env: AdminEnv): Promise<ProvisionResult> {
  const migrated = await migrate(env.DATABASE_URL_ADMIN);
  const pool = createPool(env.DATABASE_URL_ADMIN, { max: 1 });
  try {
    const roles: string[] = [];
    for (const [role, variable] of ROLE_PASSWORD_VARS) {
      const password = env[variable];
      if (password === undefined) continue;
      // ALTER ROLE takes no parameters; the server builds the statement with the quoting rules for names and text.
      const { rows } = await pool.query<{ statement: string }>(
        "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS statement",
        [role, password],
      );
      await pool.query(rows[0]?.statement ?? '');
      roles.push(role);
    }
    return { ...migrated, roles };
  } finally {
    await pool.end();
  }
}
