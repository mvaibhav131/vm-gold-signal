import {
  BOT_COMMANDS,
  alreadyPausedReply,
  dayWindow,
  displayOptionsOf,
  engineEventKey,
  engineFactsOf,
  enginePausedMessage,
  helpReply,
  isPaused,
  linkCodeOf,
  linkInvalidReply,
  linkedReply,
  monthReply,
  monthWindow,
  noClosedReply,
  notPausedReply,
  openReply,
  openRiskR,
  pauseArgument,
  pauseIdOf,
  pauseUsageReply,
  pausedAt,
  parseCommand,
  resumedReply,
  sessionAt,
  startReply,
  statusReply,
  systemChannels,
  systemOutboxRows,
  todayReply,
  unknownCommandReply,
  unrealisedR,
  type AlertSettings,
  type StatusData,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { BotStore } from './botStore';
import type { TelegramClient, TelegramUpdate } from './client';
import { checkLink } from './link';
import type { TelegramTransport } from './transport';

export interface TelegramBotOptions {
  readonly client: Pick<TelegramClient, 'getMe' | 'getUpdates' | 'setMyCommands'>;
  readonly transport: Pick<TelegramTransport, 'sendWhenReady'>;
  readonly store: BotStore;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  /** The feed as this process sees it; without it `/status` says the feed state is not available. */
  readonly feed?: () => StatusData['feed'];
  /** Rows were written to the outbox: wake the sender. */
  readonly onQueued?: () => void;
  readonly now?: () => number;
  /** Seconds one long poll waits. */
  readonly pollTimeoutS?: number;
  /** How long to wait after an error before the next try. */
  readonly retryMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

/** A quote older than this is not "the price now" for `/open`. */
const QUOTE_MAX_AGE_MS = 120_000;
/** An update whose handling fails is tried this many times, then skipped, so one bad update cannot stop the bot. */
const MAX_HANDLING_TRIES = 3;

const COMMAND_MENU = BOT_COMMANDS.filter((command) => command !== 'start' && command !== 'link');
const MENU_TEXT: Readonly<Record<(typeof COMMAND_MENU)[number], string>> = {
  help: 'The command list',
  status: 'Feed, engine, session and open signals',
  open: 'Open signals with live R',
  last: 'The last closed signal',
  today: "Today's signals and net R",
  month: 'The monthly summary',
  pause: 'Pause new signals: /pause or /pause 30',
  resume: 'Resume new signals',
};

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The Telegram bot (04_API_and_Notifications section 4). It reads updates by long polling, so no
 * inbound port is open, and serves one chat: the one that `/link` with the one-time code of
 * `telegram:link` connected. Every other chat, and every message that is not a command, is ignored
 * without an answer, so the bot does not even show a stranger that it is a bot with commands. The
 * only command a stranger can use is `/link`, and only while a code is pending.
 */
export class TelegramBot {
  private readonly options: TelegramBotOptions;
  private readonly now: () => number;
  private readonly log: NonNullable<TelegramBotOptions['log']>;
  private readonly pollTimeoutS: number;
  private readonly retryMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private username: string | null = null;
  private ready = false;
  private offset: number | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private failures = { updateId: -1, count: 0 };
  private counters = { handled: 0, ignored: 0, skipped: 0, errors: 0 };

  constructor(options: TelegramBotOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.pollTimeoutS = options.pollTimeoutS ?? 30;
    this.retryMs = options.retryMs ?? 5_000;
    this.sleep = options.sleep ?? sleepFor;
  }

  get stats(): { handled: number; ignored: number; skipped: number; errors: number } {
    return { ...this.counters };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
    this.loop = null;
  }

  /** Learns the name of the bot (so `/status@OtherBot` is not taken) and sets the command menu. */
  private async prepare(): Promise<void> {
    const me = await this.options.client.getMe();
    this.username = me.username;
    await this.options.client.setMyCommands(
      COMMAND_MENU.map((command) => ({ command, description: MENU_TEXT[command] })),
    );
    this.ready = true;
    this.log('info', 'the Telegram bot is ready', { username: me.username });
  }

  /** One round: get the updates that are waiting (or wait for one), and handle them. Returns how many came. */
  async poll(signal?: AbortSignal): Promise<number> {
    if (!this.ready) await this.prepare();
    const updates = await this.options.client.getUpdates({
      offset: this.offset,
      timeoutS: this.pollTimeoutS,
      ...(signal === undefined ? {} : { signal }),
    });
    for (const update of updates) {
      await this.handleOrSkip(update);
      this.offset = update.updateId + 1;
    }
    return updates.length;
  }

  private async handleOrSkip(update: TelegramUpdate): Promise<void> {
    for (;;) {
      try {
        await this.handle(update);
        return;
      } catch (error) {
        const same = this.failures.updateId === update.updateId;
        this.failures = { updateId: update.updateId, count: same ? this.failures.count + 1 : 1 };
        this.counters.errors += 1;
        this.log('error', 'the bot could not handle an update', {
          updateId: update.updateId,
          tries: this.failures.count,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.failures.count >= MAX_HANDLING_TRIES) {
          this.counters.skipped += 1;
          return;
        }
        if (this.stopped()) throw error;
        await this.sleep(this.retryMs, this.abort?.signal ?? new AbortController().signal);
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.running) {
      try {
        await this.poll(signal);
      } catch (error) {
        if (this.stopped()) break;
        this.counters.errors += 1;
        this.log('error', 'the bot could not poll Telegram', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(this.retryMs, signal);
      }
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
    await this.options.transport.sendWhenReady(chatId, text);
  }

  /** `stop()` may be called while an update is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }

  /** Handles one update. Owner only: everything from another chat is dropped before anything is read. */
  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message?.chatType !== 'private') {
      this.counters.ignored += 1;
      return;
    }
    const command = parseCommand(message.text, this.username ?? undefined);
    if (command === null) {
      this.counters.ignored += 1;
      return;
    }
    const { store } = this.options;
    const now = this.now();
    if (command.command === 'link') {
      await this.link(message.chatId, command.args, now);
      return;
    }
    if ((await store.linkedChat()) !== message.chatId) {
      this.counters.ignored += 1;
      return;
    }
    this.counters.handled += 1;

    const settings = await this.options.settings();
    const display = displayOptionsOf(settings);
    const chatId = message.chatId;
    switch (command.command) {
      case 'start':
        await this.reply(chatId, startReply(display).text);
        return;
      case 'help':
        await this.reply(chatId, helpReply(display).text);
        return;
      case 'status':
        await this.reply(chatId, (await this.status(settings, now)).text);
        return;
      case 'open':
        await this.reply(chatId, (await this.open(display, now)).text);
        return;
      case 'last': {
        const texts = await store.lastClosedTexts();
        if (texts.length === 0) await this.reply(chatId, noClosedReply(display).text);
        for (const text of texts) await this.reply(chatId, text);
        return;
      }
      case 'today': {
        const rows = await store.periodRows(dayWindow(now, display.displayTz));
        await this.reply(chatId, todayReply({ at: now, rows }, display).text);
        return;
      }
      case 'month': {
        const window = monthWindow(now, display.displayTz);
        const rows = await store.periodRows(window);
        await this.reply(chatId, monthReply({ monthStart: window.from, rows }, display).text);
        return;
      }
      case 'pause':
        await this.pause(chatId, command.args, settings, now);
        return;
      case 'resume': {
        const state = await store.engine();
        if (!isPaused(state, now)) {
          await this.reply(chatId, notPausedReply(display).text);
          return;
        }
        await store.saveEngine({ status: 'RUNNING' }, now);
        await this.reply(chatId, resumedReply(now, display).text);
        return;
      }
      case 'unknown':
        await this.reply(chatId, unknownCommandReply(command.name, display).text);
    }
  }

  private async link(chatId: number, args: readonly string[], now: number): Promise<void> {
    const { store } = this.options;
    const pending = await store.pendingLink();
    if (pending === null) {
      this.counters.ignored += 1;
      return;
    }
    const display = displayOptionsOf(await this.options.settings());
    const code = linkCodeOf(args);
    if (code === null) {
      await this.reply(chatId, linkInvalidReply(display).text);
      return;
    }
    const check = checkLink(pending, code, now);
    if (check.ok) {
      await store.linkChat(chatId, now);
      this.counters.handled += 1;
      await this.reply(chatId, linkedReply(display).text);
      return;
    }
    await store.setPendingLink(check.next);
    await this.reply(chatId, linkInvalidReply(display).text);
  }

  private async status(settings: AlertSettings, now: number) {
    const { store } = this.options;
    const [facts, engine] = await Promise.all([store.status(now), store.engine()]);
    const data: StatusData = {
      at: now,
      feed: this.options.feed?.() ?? null,
      engine: engineFactsOf(engine, now),
      session: sessionAt(now),
      regime: null,
      nextHigh: facts.nextHigh,
      openCount: facts.openStatuses.length,
      openRiskR: openRiskR(facts.openStatuses),
      strategies: facts.strategies.map((strategy) => ({
        ...strategy,
        alerts: settings.strategyAlerts[strategy.key] === 'on',
      })),
    };
    return statusReply(data, displayOptionsOf(settings));
  }

  private async open(display: ReturnType<typeof displayOptionsOf>, now: number) {
    const { store } = this.options;
    const rows = await store.open();
    const quote = rows.length === 0 ? null : await store.quote(now, QUOTE_MAX_AGE_MS);
    const lines = rows.map((row) => {
      const price = quote === null ? null : row.side === 'BUY' ? quote.bid : quote.ask;
      return {
        seq: row.seq,
        side: row.side,
        strategyKey: row.strategyKey,
        status: row.status,
        price,
        unrealisedR: price === null ? null : unrealisedR(row, price),
        entry: row.entry,
        stop: row.stop,
        tp1: row.tp1,
        tp2: row.tp2,
        timeStopAt: row.timeStopAt,
      };
    });
    return openReply(
      { at: now, lines, waitReasons: [] },
      display,
      openRiskR(rows.map((row) => row.status)),
    );
  }

  /**
   * `/pause [minutes]`. The reply is the ENGINE_PAUSED message itself, so the owner who paused in
   * Telegram sees it once; the other channel (Web Push) gets it through the outbox under the
   * same event key, so the dashboard or a retry cannot tell it twice.
   */
  private async pause(
    chatId: number,
    args: readonly string[],
    settings: AlertSettings,
    now: number,
  ): Promise<void> {
    const { store } = this.options;
    const display = displayOptionsOf(settings);
    const argument = pauseArgument(args);
    if (!argument.ok) {
      await this.reply(chatId, pauseUsageReply(display).text);
      return;
    }
    const current = await store.engine();
    if (isPaused(current, now)) {
      await this.reply(chatId, alreadyPausedReply(current.since, display).text);
      return;
    }
    const next = pausedAt(now, argument.minutes);
    await store.saveEngine(next, now);
    const message = enginePausedMessage({ at: now, until: next.until }, display);
    const others = systemChannels(settings, 'ENGINE_PAUSED').filter(
      (channel) => channel !== 'telegram',
    );
    const rows = systemOutboxRows(message, engineEventKey(pauseIdOf(now)), others, now);
    if (rows.length > 0) {
      await this.options.outbox.enqueue(rows, now);
      this.options.onQueued?.();
    }
    await this.reply(chatId, message.telegram.text);
  }
}
