import { apiCliEnvSchema, parseEnv } from '@vmgs/config';
import { createPool } from '@vmgs/db';

import { PRODUCTION_ARGON, SecretHasher } from '../auth/hasher';
import { Limiter } from '../auth/limiter';
import { PostgresAuthStore } from '../auth/postgresStore';
import { CLI_USAGE, runCli } from './commands';
import { isTerminal, passwordReader } from './terminal';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(`${CLI_USAGE}\n`);
    return 2;
  }
  const env = parseEnv(apiCliEnvSchema, process.env);
  const pool = createPool(env.DATABASE_URL_API, { max: 2 });
  try {
    return await runCli(args, {
      store: new PostgresAuthStore(pool),
      hasher: new SecretHasher(PRODUCTION_ARGON, new Limiter(1, 0)),
      now: Date.now,
      print: (line) => process.stdout.write(`${line}\n`),
      readSecret: passwordReader(process.stdin, process.stderr),
      interactive: isTerminal(process.stdin),
    });
  } finally {
    await pool.end();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
