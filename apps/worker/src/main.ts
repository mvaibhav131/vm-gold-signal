import { defaultStrategyConfig, workerEnvSchema, parseEnv } from '@vmgs/config';
import { STRATEGY_KEYS } from '@vmgs/core';
import { Feed } from '@vmgs/feed';
import { BiquoteProvider } from '@vmgs/feed';
import { createPool } from '@vmgs/db';

import { HealthWatcher } from './alerts/health';
import { PostgresHealthStore } from './alerts/postgresHealthStore';
import { PostgresOutboxStore } from './alerts/postgresOutboxStore';
import { OutboxSender } from './alerts/sender';
import { LibWebPushSink } from './alerts/webpush';
import { DatabaseCourseSource } from './lifecycle/course';
import { PostgresLifecycleStore } from './lifecycle/postgresStore';
import { OutcomeTracker } from './lifecycle/tracker';
import { PostgresRecorderStore } from './postgresStore';
import { RecorderWorker } from './recorder';
import { TelegramBot } from './telegram/bot';
import { TelegramClient } from './telegram/client';
import { PostgresBotStore } from './telegram/postgresBotStore';
import { TelegramTransport } from './telegram/transport';

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

  // The outcome tracker follows open signals on the ticks the recorder has stored. It starts first:
  // it rebuilds every open signal from the stored ticks before the live feed adds to them.
  const lifecycle = new PostgresLifecycleStore(pool);
  for (const key of STRATEGY_KEYS)
    await lifecycle.ensureStrategyVersion(defaultStrategyConfig(key));
  const tracker = new OutcomeTracker({
    store: lifecycle,
    market: lifecycle,
    course: new DatabaseCourseSource(lifecycle),
    onFatalError,
    log,
  });
  const worker = new RecorderWorker({
    feed,
    store: new PostgresRecorderStore(pool),
    symbols: env.FEED_SYMBOLS,
    providerName: provider.name,
    onPersistedTicks: (ticks) => {
      tracker.onPersistedTicks(ticks);
    },
    onFatalError,
  });

  try {
    await tracker.start();
    await worker.start();

    // Alerts: the sender delivers what the lifecycle wrote into the outbox; the bot and the health
    // watcher only run with the settings they need. Without a Telegram token or VAPID keys the
    // channel is simply not served, and its messages wait or expire (04_API_and_Notifications).
    const outboxStore = new PostgresOutboxStore(pool);
    const botStore = new PostgresBotStore(pool);
    const telegramClient =
      env.TELEGRAM_BOT_TOKEN === undefined
        ? null
        : new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
    const transport =
      telegramClient === null ? null : new TelegramTransport({ client: telegramClient });
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
    const sender = new OutboxSender({
      store: outboxStore,
      ...(transport === null
        ? {}
        : { telegram: { transport, chatId: () => botStore.linkedChat() } }),
      ...(VAPID_PUBLIC_KEY === undefined ||
      VAPID_PRIVATE_KEY === undefined ||
      VAPID_SUBJECT === undefined
        ? {}
        : {
            webpush: {
              sink: new LibWebPushSink({
                subject: VAPID_SUBJECT,
                publicKey: VAPID_PUBLIC_KEY,
                privateKey: VAPID_PRIVATE_KEY,
              }),
              subscriptions: outboxStore,
            },
          }),
      log,
    });
    const health = new HealthWatcher({
      store: new PostgresHealthStore(pool),
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    const bot =
      telegramClient === null || transport === null
        ? null
        : new TelegramBot({
            client: telegramClient,
            transport,
            store: botStore,
            outbox: outboxStore,
            settings: () => lifecycle.loadSettings(),
            feed: () => {
              const { state, tickAgeMs, spread } = feed.health();
              return { state, tickAgeMs, spread };
            },
            onQueued: () => {
              sender.wake();
            },
            log,
          });
    sender.start();
    health.start();
    bot?.start();

    log('info', 'record-only worker started', {
      provider: provider.name,
      symbols: env.FEED_SYMBOLS,
      openSignals: tracker.stats.open,
      telegram: bot !== null,
      webpush: VAPID_PUBLIC_KEY !== undefined,
    });
    const reason = await stopRequested;
    if (reason === 'fatal') process.exitCode = 1;
    await bot?.stop();
    await health.stop();
    await worker.stop();
    await tracker.stop().catch(() => undefined);
    await sender.stop();
    log('info', 'record-only worker stopped', {
      reason,
      stats: worker.stats,
      tracker: tracker.stats,
      sender: sender.stats,
      bot: bot?.stats ?? null,
    });
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
