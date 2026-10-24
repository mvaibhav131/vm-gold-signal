import { workerEnvSchema, parseEnv } from '@vmgs/config';
import { Feed } from '@vmgs/feed';
import { BiquoteProvider } from '@vmgs/feed';
import { createPool } from '@vmgs/db';

import { PostgresRecorderStore } from './postgresStore';
import { RecorderWorker } from './recorder';

type StopReason = 'signal' | 'fatal';

function log(
  level: 'info' | 'error',
  message: string,
  details: Record<string, unknown> = {},
): void {
  const output = level === 'error' ? process.stderr : process.stdout;
  output.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...details })}\n`);
}

async function main(): Promise<void> {
  const env = parseEnv(workerEnvSchema, process.env);
  if (env.FEED_PROVIDER !== 'biquote') {
    throw new Error('the record-only worker runtime currently requires FEED_PROVIDER=biquote');
  }

  const pool = createPool(env.DATABASE_URL_WORKER, { max: 4 });
  let resolveStop: (reason: StopReason) => void = () => undefined;
  const stopRequested = new Promise<StopReason>((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = () => {
    resolveStop('signal');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const provider = new BiquoteProvider({
    symbols: env.FEED_SYMBOLS,
    log: (level, message, details) => {
      log(level === 'error' ? 'error' : 'info', message, details);
    },
  });
  const onFatalError = (error: unknown) => {
    log('error', 'recorder worker failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    resolveStop('fatal');
  };
  const feed = new Feed({
    provider,
    symbols: env.FEED_SYMBOLS,
    onListenerError: onFatalError,
  });
  const worker = new RecorderWorker({
    feed,
    store: new PostgresRecorderStore(pool),
    symbols: env.FEED_SYMBOLS,
    providerName: provider.name,
    onFatalError,
  });

  try {
    await worker.start();
    log('info', 'record-only worker started', {
      provider: provider.name,
      symbols: env.FEED_SYMBOLS,
    });
    const reason = await stopRequested;
    if (reason === 'fatal') process.exitCode = 1;
    await worker.stop();
    log('info', 'record-only worker stopped', { reason, stats: worker.stats });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  log('error', 'record-only worker could not start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
