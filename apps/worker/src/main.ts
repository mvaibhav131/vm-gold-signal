import { defaultStrategyConfig, workerEnvSchema, parseEnv } from '@vmgs/config';
import { STRATEGY_KEYS, TRADED_SYMBOL, mergeNewsWindows, unrealisedR } from '@vmgs/core';
import { Feed } from '@vmgs/feed';
import { BiquoteProvider } from '@vmgs/feed';
import { createPool } from '@vmgs/db';

import { HealthWatcher } from './alerts/health';
import { PostgresHealthStore } from './alerts/postgresHealthStore';
import { PostgresOutboxStore } from './alerts/postgresOutboxStore';
import { OutboxSender } from './alerts/sender';
import { LibWebPushSink } from './alerts/webpush';
import { CalendarAlerts } from './calendar/alerts';
import { CalendarPoller } from './calendar/poller';
import { PostgresCalendarStore } from './calendar/postgresStore';
import { BiquoteCalendarClient } from './calendar/provider';
import { DatabaseCourseSource } from './lifecycle/course';
import { PostgresLifecycleStore } from './lifecycle/postgresStore';
import { OutcomeTracker } from './lifecycle/tracker';
import { NewsAlerts } from './news/alerts';
import { UnclassifiedBuffer } from './news/buffer';
import { DEFAULT_FEEDS, HeadlineFeedClient } from './news/feeds';
import { ImpactMeasurer } from './news/impact';
import { MarketMoveDetector } from './news/moves';
import { NewsPoller } from './news/poller';
import { PostgresMarketReader } from './news/postgresMarketReader';
import { PostgresNewsStore } from './news/postgresStore';
import { NewsFeedWatcher } from './news/watcher';
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
  // The move detector is built after the alert machinery; the recorder may deliver ticks before that.
  let moves: MarketMoveDetector | null = null;
  const worker = new RecorderWorker({
    feed,
    store: new PostgresRecorderStore(pool),
    symbols: env.FEED_SYMBOLS,
    providerName: provider.name,
    onPersistedTicks: (ticks) => {
      tracker.onPersistedTicks(ticks);
      moves?.onTicks(ticks);
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
    // The calendar: the poller keeps `macro_events` and the time of its last good reading (without a
    // recent one the news state is UNKNOWN); the alerts tell about the events that matter. The
    // news window is the widest of the strategies' defaults until the engine reads its own (B26b).
    const calendarStore = new PostgresCalendarStore(pool, TRADED_SYMBOL);
    const newsWindow = mergeNewsWindows(
      STRATEGY_KEYS.map((key) => defaultStrategyConfig(key).gates.newsWindow),
    );
    const calendarProvider = new BiquoteCalendarClient();
    const calendarPoller = new CalendarPoller({
      provider: calendarProvider,
      store: calendarStore,
      policy: async () => ({
        currencies: newsWindow.currency,
        minImpact: (await lifecycle.loadSettings()).newsAlerts.minImpact,
      }),
      log,
    });
    const calendarAlerts = new CalendarAlerts({
      store: calendarStore,
      provider: calendarProvider,
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      window: newsWindow,
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    // Headlines and sudden moves (B25b): the poller reads the free feeds into `news_items`, the alerts tell
    // about the stories that matter, the watcher about the feeds themselves, the measurer records what gold
    // did after each story, and the detector watches the stored ticks for a sudden move.
    const newsStore = new PostgresNewsStore(pool);
    const marketReader = new PostgresMarketReader(pool, TRADED_SYMBOL);
    const unclassified = new UnclassifiedBuffer();
    const newsAlerts = new NewsAlerts({
      news: newsStore,
      impact: newsStore,
      market: marketReader,
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    const newsPoller = new NewsPoller({
      feeds: DEFAULT_FEEDS,
      client: new HeadlineFeedClient(),
      store: newsStore,
      buffer: unclassified,
      onNew: () => {
        newsAlerts.nudge();
      },
      log,
    });
    const newsWatcher = new NewsFeedWatcher({
      store: newsStore,
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    const impactMeasurer = new ImpactMeasurer({ impact: newsStore, market: marketReader, log });
    moves = new MarketMoveDetector({
      market: marketReader,
      news: newsStore,
      moves: newsStore,
      buffer: unclassified,
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      open: async () => {
        const rows = await botStore.open();
        const quote = rows.length === 0 ? null : await botStore.quote(Date.now(), 120_000);
        return rows.map((row) => {
          const price = quote === null ? null : row.side === 'BUY' ? quote.bid : quote.ask;
          return {
            seq: row.seq,
            side: row.side,
            unrealisedR: price === null ? null : unrealisedR(row, price),
          };
        });
      },
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    sender.start();
    health.start();
    bot?.start();
    calendarPoller.start();
    calendarAlerts.start();
    newsPoller.start();
    newsAlerts.start();
    newsWatcher.start();
    impactMeasurer.start();
    moves.start();

    log('info', 'record-only worker started', {
      provider: provider.name,
      symbols: env.FEED_SYMBOLS,
      openSignals: tracker.stats.open,
      telegram: bot !== null,
      webpush: VAPID_PUBLIC_KEY !== undefined,
      calendar: calendarProvider.name,
      headlineFeeds: DEFAULT_FEEDS.map((source) => source.key),
    });
    const reason = await stopRequested;
    if (reason === 'fatal') process.exitCode = 1;
    await moves.stop();
    await impactMeasurer.stop();
    await newsWatcher.stop();
    await newsAlerts.stop();
    await newsPoller.stop();
    await calendarAlerts.stop();
    await calendarPoller.stop();
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
      calendar: calendarPoller.stats,
      news: newsPoller.stats,
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
