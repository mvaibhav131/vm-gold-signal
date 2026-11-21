import { defaultStrategyConfig, strategySpecOf, workerEnvSchema, parseEnv } from '@vmgs/config';
import { ACTIVE_STRATEGY_KEYS, TRADED_SYMBOL, mergeNewsWindows, unrealisedR } from '@vmgs/core';
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
import { SignalCreator } from './lifecycle/signals';
import { OutcomeTracker } from './lifecycle/tracker';
import { NoDisk, databaseOnThisMachine } from './maintenance/disk';
import { RollupReconcileJob, RetentionJob, SizeGuard } from './maintenance/jobs';
import { PostgresMaintenanceStore, StatfsDisk } from './maintenance/postgresStore';
import { MaintenanceRunner } from './maintenance/runner';
import { NewsAlerts } from './news/alerts';
import { NewsContextReader } from './news/context';
import { UnclassifiedBuffer } from './news/buffer';
import { DEFAULT_FEEDS, HeadlineFeedClient } from './news/feeds';
import { ImpactMeasurer } from './news/impact';
import { MarketMoveDetector } from './news/moves';
import { NewsPoller } from './news/poller';
import { PostgresMarketReader } from './news/postgresMarketReader';
import { PostgresNewsStore } from './news/postgresStore';
import { NewsFeedWatcher } from './news/watcher';
import { isFresh, workerHeartbeatAgeMs } from './ops/alive';
import { startHealthServer } from './ops/healthServer';
import { HealthPinger } from './ops/pinger';
import { PostgresRecorderStore } from './postgresStore';
import { calendarContextOf } from './engine/context';
import { DecisionLoop } from './engine/loop';
import { PostgresEngineStore } from './engine/postgresStore';
import { RecorderWorker } from './recorder';
import { PostgresReportStore } from './reports/postgresStore';
import { ReportScheduler } from './reports/scheduler';
import { PostgresRollupStore } from './rollups/postgres';
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

  const pool = createPool(env.DATABASE_URL_WORKER, {
    max: env.DATABASE_POOL_MAX ?? 8,
    ca: env.DATABASE_CA_PEM,
  });
  let resolveStop: (reason: StopReason) => void = () => undefined;
  const stopRequested = new Promise<StopReason>((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = () => {
    resolveStop('signal');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // For a host that wants to see the container answer on a port (a "web service" host). It listens from the first
  // second, so that the host sees the worker while the engine warms up.
  const healthPage =
    env.PORT === undefined
      ? null
      : await startHealthServer({
          port: env.PORT,
          heartbeatAgeMs: () => workerHeartbeatAgeMs(pool, Date.now()),
        });

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
  // A retired strategy is not registered and not run: its old signals stay in the database, and the tracker follows any that is still open.
  const configs = ACTIVE_STRATEGY_KEYS.map((key) => defaultStrategyConfig(key));
  const specs = [];
  for (const config of configs) {
    const stored = await lifecycle.ensureStrategyVersion(config);
    specs.push(strategySpecOf(config, stored.status));
  }
  // The decision loop owns the candles and features of the engine, so it knows the regime at the close of a trade
  // and the changes of character that the review asks for; it is built later, the tracker asks it once it is there.
  let decisions: DecisionLoop | null = null;
  const tracker = new OutcomeTracker({
    store: lifecycle,
    market: lifecycle,
    course: new DatabaseCourseSource(lifecycle, {
      contextOf: (trade, closedAt) =>
        Promise.resolve(
          decisions === null
            ? { regimeAtClose: null, structureBreaks: [] }
            : decisions.contextOf(trade, closedAt),
        ),
    }),
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
    onPersistedCandles: () => {
      decisions?.wake();
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
    // The alert bot: its own client and rate limit, and the same chat id (in a private chat the id is the person's, whichever
    // bot it is). It can only write once the owner has pressed Start in it; until then its messages wait and are retried.
    const alertTransport =
      telegramClient === null || env.TELEGRAM_ALERT_BOT_TOKEN === undefined
        ? null
        : new TelegramTransport({
            client: new TelegramClient({ token: env.TELEGRAM_ALERT_BOT_TOKEN }),
          });
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
    const sender = new OutboxSender({
      store: outboxStore,
      ...(transport === null
        ? {}
        : { telegram: { transport, chatId: () => botStore.linkedChat() } }),
      ...(alertTransport === null
        ? {}
        : { alerts: { transport: alertTransport, chatId: () => botStore.linkedChat() } }),
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
      ACTIVE_STRATEGY_KEYS.map((key) => defaultStrategyConfig(key).gates.newsWindow),
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
    // Maintenance (B26): the nightly reconciliation of the rollups and retention, and the hourly size guard.
    const maintenanceStore = new PostgresMaintenanceStore(pool);
    const maintenance = new MaintenanceRunner({
      nightly: [
        new RollupReconcileJob(new PostgresRollupStore(pool), log),
        new RetentionJob(maintenanceStore, maintenanceStore),
      ],
      hourly: [
        new SizeGuard({
          storage: maintenanceStore,
          retention: maintenanceStore,
          // a database at a host (Aiven) has a disk of its own: this container's disk says nothing about it
          disk: databaseOnThisMachine(env.DATABASE_URL_WORKER) ? new StatfsDisk() : new NoDisk(),
          ...(env.DB_SOFT_LIMIT_GB === undefined
            ? {}
            : { dbLimitBytes: env.DB_SOFT_LIMIT_GB * 1_000_000_000 }),
          outbox: outboxStore,
          settings: () => lifecycle.loadSettings(),
          onQueued: () => {
            sender.wake();
          },
          log,
        }),
      ],
      runs: maintenanceStore,
      log,
    });
    // The reports nobody asks for (B26): the day's digest after the trading day, the month's report on the 1st.
    const reports = new ReportScheduler({
      store: new PostgresReportStore(pool),
      outbox: outboxStore,
      settings: () => lifecycle.loadSettings(),
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    // The decision loop (B26b): candles of the database to signals. It warms up from the stored candles, then
    // follows the table and decides every 5m candle on its confirming quote; the recorder wakes it.
    const creator = new SignalCreator({
      store: lifecycle,
      onCreated: (signalId) => tracker.register(signalId),
    });
    await creator.registerStrategies(configs);
    const loop = new DecisionLoop({
      specs,
      store: new PostgresEngineStore(pool, TRADED_SYMBOL),
      creator,
      calendar: calendarContextOf(calendarStore),
      news: new NewsContextReader(newsStore),
      feed: () => {
        const { connected, tickAgeMs, providerStale, marketState, clockSkewMs } = feed.health();
        return { facts: { connected, tickAgeMs, providerStale, marketState }, clockSkewMs };
      },
      onQueued: () => {
        sender.wake();
      },
      log,
    });
    await loop.warmUp();
    decisions = loop;
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
    maintenance.start();
    reports.start();
    loop.start();
    // The external check (B31): a ping every minute while the worker's own heartbeat is fresh.
    const pinger =
      env.HEALTHCHECKS_PING_URL === undefined
        ? null
        : new HealthPinger({
            url: env.HEALTHCHECKS_PING_URL,
            alive: async () => isFresh(await workerHeartbeatAgeMs(pool, Date.now())),
            log,
          });
    pinger?.start();

    log('info', 'record-only worker started', {
      provider: provider.name,
      symbols: env.FEED_SYMBOLS,
      openSignals: tracker.stats.open,
      telegram: bot !== null,
      webpush: VAPID_PUBLIC_KEY !== undefined,
      heartbeatCheck: pinger !== null,
      healthPort: healthPage?.port ?? null,
      calendar: calendarProvider.name,
      headlineFeeds: DEFAULT_FEEDS.map((source) => source.key),
      engineCandles: loop.counts,
    });
    const reason = await stopRequested;
    if (reason === 'fatal') process.exitCode = 1;
    // A worker that is being stopped must not tell the check that it is unwell.
    await pinger?.stop();
    await loop.stop();
    await reports.stop();
    await maintenance.stop();
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
      decisions: loop.stats,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await healthPage?.close();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  log('error', 'record-only worker could not start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
