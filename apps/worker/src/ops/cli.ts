import {
  adminEnvSchema,
  apiEnvSchema,
  backupEnvSchema,
  parseEnv,
  workerEnvSchema,
  EnvError,
} from '@vmgs/config';
import { createPool } from '@vmgs/db';
import webpush from 'web-push';

import { WORKER_ALIVE_MAX_AGE_MS, isFresh, workerHeartbeatAgeMs } from './alive';
import { COUNTS_SQL, checkBackup, countsOf, type Counts } from './manifest';
import { provision } from './provision';
import { planBackups } from './retention';

type Env = Readonly<Record<string, string | undefined>>;

/** What the commands need from the outside, so the tests can give them something else. */
export interface OpsIo {
  print(line: string): void;
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  now(): number;
}

export const OPS_COMMANDS = [
  'db:migrate',
  'worker:alive',
  'env:check',
  'backup:counts',
  'backup:plan',
  'backup:check',
  'vapid:generate',
] as const;

export const OPS_USAGE =
  'db:migrate | worker:alive [max-age-seconds] | env:check [worker|admin|backup|api]... | ' +
  'backup:counts [ENV_VAR] | backup:plan | backup:check manifest.json restored.json live.json | vapid:generate';

const SCHEMAS = {
  worker: workerEnvSchema,
  admin: adminEnvSchema,
  backup: backupEnvSchema,
  api: apiEnvSchema,
} as const;

/** Whether the environment is complete for the named processes. Names the variable and the rule, never the value. */
function envCheck(kinds: readonly string[], env: Env, io: OpsIo): number {
  const wanted = kinds.length === 0 ? ['worker'] : kinds;
  let failed = false;
  for (const kind of wanted) {
    if (!(kind in SCHEMAS)) {
      io.print(`unknown kind ${kind}: use worker, admin, backup or api`);
      return 2;
    }
    try {
      parseEnv(SCHEMAS[kind as keyof typeof SCHEMAS], env);
      io.print(`OK ${kind}`);
    } catch (error) {
      failed = true;
      if (!(error instanceof EnvError)) throw error;
      io.print(`PROBLEM ${kind}`);
      for (const problem of error.problems) io.print(`  ${problem}`);
    }
  }
  return failed ? 1 : 0;
}

/** Reads a map of counts from JSON text; anything else is an error that names the file. */
function readCounts(text: string, file: string): Counts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a map of table counts`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([table, value]) => [
      table,
      typeof value === 'number' ? value : NaN,
    ]),
  );
}

/**
 * The operations commands of `pnpm cli` (B31). Returns the exit code, or null when the command is not one of
 * these. Reading the environment only through `env` keeps every command testable.
 */
export async function runOps(
  command: string,
  args: readonly string[],
  env: Env,
  io: OpsIo,
): Promise<number | null> {
  switch (command) {
    case 'env:check':
      return envCheck(args, env, io);

    case 'db:migrate': {
      const result = await provision(parseEnv(adminEnvSchema, env));
      io.print(
        result.applied.length === 0
          ? `schema at version ${String(result.current)}, nothing to apply`
          : `applied ${result.applied.join(', ')}; schema at version ${String(result.current)}`,
      );
      if (result.fallbacks !== undefined) {
        io.print(
          `migration ${result.fallbacks.join(', ')} ran its fallback file: this database does not let its admin grant a predefined role`,
        );
      }
      io.print(
        result.roles.length === 0
          ? 'no role password set'
          : `login set for ${result.roles.join(', ')}`,
      );
      return 0;
    }

    case 'vapid:generate': {
      // The keys that Web Push is set up with (04 section 5): a new pair, and the line for the subject to fill in. Needs no
      // database and no .env. The private key is printed once, here: it goes into the .env and nowhere else.
      const keys = webpush.generateVAPIDKeys();
      io.print(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
      io.print(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
      io.print('VAPID_SUBJECT=mailto:you@example.com');
      return 0;
    }

    case 'worker:alive': {
      const maxAgeMs = args[0] === undefined ? WORKER_ALIVE_MAX_AGE_MS : Number(args[0]) * 1000;
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        io.print('max-age-seconds must be a positive number');
        return 2;
      }
      const workerEnv = parseEnv(workerEnvSchema, env);
      const pool = createPool(workerEnv.DATABASE_URL_WORKER, {
        max: 1,
        ca: workerEnv.DATABASE_CA_PEM,
      });
      try {
        const age = await workerHeartbeatAgeMs(pool, io.now());
        if (!isFresh(age, maxAgeMs)) {
          io.print(
            age === null
              ? 'no heartbeat yet'
              : `heartbeat is ${String(Math.round(age / 1000))} s old`,
          );
          return 1;
        }
        io.print(`heartbeat is ${String(Math.round((age ?? 0) / 1000))} s old`);
        return 0;
      } finally {
        await pool.end();
      }
    }

    case 'backup:counts': {
      const variable = args[0] ?? 'DATABASE_URL_BACKUP';
      const url = env[variable];
      if (url === undefined || url === '') {
        io.print(`${variable} is not set`);
        return 2;
      }
      const pool = createPool(url, { max: 1 });
      try {
        const { rows } = await pool.query<{ table_name: string; n: string }>(COUNTS_SQL);
        io.print(JSON.stringify(countsOf(rows)));
        return 0;
      } finally {
        await pool.end();
      }
    }

    case 'backup:plan': {
      const names = (await io.readStdin())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const plan = planBackups(names);
      for (const name of plan.keep) io.print(`KEEP ${name}`);
      for (const name of plan.remove) io.print(`REMOVE ${name}`);
      for (const name of plan.ignored) io.print(`IGNORE ${name}`);
      return 0;
    }

    case 'backup:check': {
      const [manifest, restored, live] = args;
      if (manifest === undefined || restored === undefined || live === undefined) {
        io.print('usage: backup:check manifest.json restored.json live.json');
        return 2;
      }
      const check = checkBackup({
        manifest: readCounts(await io.readFile(manifest), manifest),
        restored: readCounts(await io.readFile(restored), restored),
        live: readCounts(await io.readFile(live), live),
      });
      for (const line of check.lines) io.print(line);
      for (const problem of check.problems) io.print(`PROBLEM ${problem}`);
      io.print(
        check.ok
          ? 'OK the restored copy matches the backup'
          : 'FAILED the restored copy is not a good copy',
      );
      return check.ok ? 0 : 1;
    }

    default:
      return null;
  }
}
