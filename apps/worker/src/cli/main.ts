import { parseEnv, workerEnvSchema } from '@vmgs/config';
import { createPool } from '@vmgs/db';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { PostgresOutboxStore } from '../alerts/postgresOutboxStore';
import { PostgresLifecycleStore } from '../lifecycle/postgresStore';
import { OPS_USAGE, runOps } from '../ops/cli';
import { TelegramClient } from '../telegram/client';
import { PostgresBotStore } from '../telegram/postgresBotStore';
import { telegramPreview } from './preview';
import { telegramLink, telegramTest } from './telegram';

const USAGE = `usage: pnpm cli <telegram:preview [hinglish] | telegram:link | telegram:test | ${OPS_USAGE}>`;

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Needs only the bot token: no database, no worker. */
async function preview(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token === '') throw new Error('set TELEGRAM_BOT_TOKEN in .env');
  const language = process.argv[3];
  if (language !== undefined && language !== 'en' && language !== 'hinglish') {
    throw new Error(USAGE);
  }
  await telegramPreview({
    client: new TelegramClient({ token }),
    options: { locale: language ?? 'en', displayTz: 'Asia/Kolkata' },
    print,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'telegram:preview') {
    await preview();
    return;
  }
  const exitCode = await runOps(command ?? '', process.argv.slice(3), process.env, {
    print,
    readStdin,
    readFile: (path) => readFile(path, 'utf8'),
    now: Date.now,
  });
  if (exitCode !== null) {
    process.exitCode = exitCode;
    return;
  }
  if (command !== 'telegram:link' && command !== 'telegram:test') throw new Error(USAGE);
  const env = parseEnv(workerEnvSchema, process.env);
  const pool = createPool(env.DATABASE_URL_WORKER, { max: 2 });
  try {
    if (command === 'telegram:link') {
      if (env.TELEGRAM_BOT_TOKEN === undefined) throw new Error('set TELEGRAM_BOT_TOKEN in .env');
      await telegramLink({
        store: new PostgresBotStore(pool),
        client: new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN }),
        now: Date.now(),
        print,
      });
    } else {
      await telegramTest({
        outbox: new PostgresOutboxStore(pool),
        settings: await new PostgresLifecycleStore(pool).loadSettings(),
        now: Date.now(),
        id: randomUUID(),
        print,
      });
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
