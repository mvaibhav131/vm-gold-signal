import { parseEnv, researchEnvSchema } from '@vmgs/config';
import { createPool } from '@vmgs/db';

import { PostgresBootstrapStore } from './bootstrap/store';
import { checkCommand, importCommand, spreadCommand } from './commands';
import { backtestCli } from './backtestCli';
import { sourcesOf } from './files';

const USAGE =
  'usage: pnpm research <histdata:check <files or folders...> | histdata:import [--dry-run] <files or folders...> | spread:model | backtest:run [--strategy a,b] [--spread 0.2] [--holdout] [--notes text] [--out reports] <files or folders...> | backtest:ablate --strategy k --set path=value [--set ...] <files or folders...>>';

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Where the owner typed the command: pnpm runs the tool in its own folder and tells the original one here. */
const BASE = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  const paths = rest.filter((arg) => !arg.startsWith('--'));

  if (command === 'histdata:check') {
    if (!checkCommand(sourcesOf(paths, BASE), print)) process.exitCode = 1;
    return;
  }
  if (command === 'backtest:run' || command === 'backtest:ablate') {
    backtestCli(command, rest, BASE, print);
    return;
  }
  if (command !== 'histdata:import' && command !== 'spread:model') throw new Error(USAGE);

  const env = parseEnv(researchEnvSchema, process.env);
  const pool = createPool(env.DATABASE_URL_WORKER, { max: 2 });
  try {
    const store = new PostgresBootstrapStore(pool);
    if (command === 'spread:model') {
      await spreadCommand({ store, now: Date.now(), print });
    } else if (
      !(await importCommand({
        sources: sourcesOf(paths, BASE),
        store,
        dryRun,
        now: Date.now(),
        print,
      }))
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
