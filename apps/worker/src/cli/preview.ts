import {
  dailyDigestMessage,
  enginePausedMessage,
  feedDegradedMessage,
  feedRecoveredMessage,
  headlineFeedsBackMessage,
  headlineFeedsDownMessage,
  marketMoveMessage,
  monthWindow,
  monthlyReportMessage,
  newsHeadlineMessage,
  newsReleasedMessage,
  newsUpcomingMessage,
  parseCommand,
  possibleCauses,
  renderFinalReview,
  renderSignalCancelled,
  renderSignalClosed,
  renderSignalNew,
  renderSignalTp1,
  storageWarningMessage,
  testMessage,
  tradingDayOf,
  type CalendarRecord,
  type DisplayOptions,
  type HeadlineCluster,
  type MoveDetection,
  type ReportRow,
  type UnclassifiedHeadline,
} from '@vmgs/core';

import {
  BUY_SIGNAL,
  FINAL_REVIEW,
  LOSS,
  MINUTE,
  REVIEW,
  SELL_SIGNAL,
  WIN_TP2,
  newSignal,
} from '../../../../packages/core/src/messages/test-data';
import { DECIDED_AT } from '../../../../packages/core/src/trade/test-data';
import type { TelegramClient } from '../telegram/client';
import { TelegramTransport } from '../telegram/transport';

export interface Sample {
  readonly name: string;
  readonly text: string;
}

/** The CPI that the example signal looks ahead to (16:00 IST, 4 h 25 min after the signal). */
const CPI_AT = DECIDED_AT + (4 * 60 + 25) * MINUTE;
const CPI: CalendarRecord = {
  id: 'sample',
  sourceEventId: 'sample',
  seriesId: 'sample',
  scheduledAt: CPI_AT,
  importance: 'high',
  currency: 'USD',
  countryCode: 'US',
  name: 'CPI m/m',
  unit: 'percent',
  multiplier: 'none',
  digits: 1,
  actual: null,
  forecast: 0.3,
  previous: 0.4,
  revisedPrevious: null,
  timeMode: 'exact',
  firstSeenAt: DECIDED_AT,
  actualFirstSeenAt: null,
};

/** A story two outlets ran, 2 minutes before the example time, and one that no rule recognised. */
const STORY: HeadlineCluster = {
  id: 'sample',
  title: 'Fed officials signal rates may stay higher for longer',
  url: 'https://example.com/fed-officials-signal-rates',
  sources: [
    { key: 'cnbc_top', name: 'CNBC' },
    { key: 'bbc_world', name: 'BBC News' },
  ],
  topics: ['FED_RATES'],
  impact: 'HIGH',
  publishedAt: DECIDED_AT - 2 * MINUTE,
  firstSeenAt: DECIDED_AT - MINUTE,
};
const OTHER_STORY: UnclassifiedHeadline = {
  title: 'Local bakery wins a prize',
  url: 'https://example.com/bakery',
  sourceName: 'Al Jazeera',
  publishedAt: DECIDED_AT - 3 * MINUTE,
  firstSeenAt: DECIDED_AT - 2 * MINUTE,
};
const SPIKE: MoveDetection = {
  kind: 'SPIKE_UP',
  windowS: 240,
  moveUsd: 10,
  moveAtr: 3.3,
  basis: '5m',
  atr: 3,
  at: DECIDED_AT,
};

/** A signal of a report: a result (or none, for one still open) with its R, session, score and the groups that were weak at entry. */
function reportRow(
  change: Partial<ReportRow> & Pick<ReportRow, 'result'>,
  net: number | null = null,
): ReportRow {
  const counted =
    change.result !== null && change.result !== 'CANCELLED' && change.result !== 'DATA_INVALID';
  return {
    seq: 1,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    session: 'LONDON',
    qualityScore: 78,
    generatedAt: DECIDED_AT,
    countsInStats: counted,
    realizedRNet: counted ? net : null,
    durationS: 1500,
    tp1Hit: net !== null && net > 0,
    tp2Hit: false,
    closedAt: DECIDED_AT + 25 * MINUTE,
    primaryCause: null,
    weakGroups: [],
    ...change,
  };
}

/** The signals of the example trading day (02_Signal_Engine section 14): the S-0042 win, a loss that was weak in its trigger, one still open. */
const DAY_ROWS: ReportRow[] = [
  reportRow({ result: 'WIN' }, 1.47),
  reportRow({ result: 'LOSS', primaryCause: 'NO_FOLLOW_THROUGH', weakGroups: ['trigger'] }, -1.04),
  reportRow({ result: null }),
];

/** A month: 12 results in London (7 winners), 9 in Asia (3 winners), one cancelled, one with invalid data, one open. */
function monthRows(): ReportRow[] {
  const results = (count: number, winners: number, change: Partial<ReportRow>): ReportRow[] =>
    Array.from({ length: count }, (_, i) =>
      i < winners
        ? reportRow({ result: 'WIN', ...change }, 1.5)
        : reportRow({ result: 'LOSS', primaryCause: 'NORMAL_LOSS', ...change }, -1),
    );
  return [
    ...results(12, 7, { session: 'LONDON', qualityScore: 80 }),
    ...results(9, 3, { session: 'ASIA', qualityScore: 70, strategyKey: 'sweep_reversal' }),
    reportRow({ result: 'CANCELLED' }),
    reportRow({ result: 'DATA_INVALID' }),
    reportRow({ result: null }),
  ];
}

/**
 * One example of every message the owner will receive, written with the real formatters on fixed
 * example data (the S-0042 BUY of 02_Signal_Engine section 14), so what is reviewed is what will
 * be sent. Nothing here comes from the market.
 */
export function sampleMessages(options: DisplayOptions): Sample[] {
  const signal = BUY_SIGNAL;
  const down = { kind: 'STALE', since: DECIDED_AT, silentMs: 18_000, openSeqs: [45] } as const;
  return [
    { name: 'SIGNAL_NEW', text: renderSignalNew(newSignal(signal), options).text },
    { name: 'SIGNAL_NEW, a SELL', text: renderSignalNew(newSignal(SELL_SIGNAL), options).text },
    {
      name: 'SIGNAL_TP1',
      text: renderSignalTp1({ signal, at: DECIDED_AT + 6 * MINUTE, price: signal.tp1 }, options)
        .text,
    },
    {
      name: 'SIGNAL_CLOSED, a win',
      text: renderSignalClosed({ signal, outcome: WIN_TP2, review: null }, options).text,
    },
    {
      name: 'SIGNAL_CLOSED, a loss with its review',
      text: renderSignalClosed({ signal, outcome: LOSS, review: REVIEW }, options).text,
    },
    {
      name: 'SIGNAL_CANCELLED',
      text: renderSignalCancelled({ signal, staleSeconds: 18 }, options).text,
    },
    {
      name: 'SIGNAL_REVIEW_FINAL',
      text: renderFinalReview(
        {
          signal,
          review: FINAL_REVIEW,
          previousPrimary: REVIEW.primaryCause,
          trackedThisMonth: 3,
        },
        options,
      ).text,
    },
    { name: 'SYSTEM_DEGRADED', text: feedDegradedMessage(down, options).telegram.text },
    {
      name: 'SYSTEM_RECOVERED',
      text: feedRecoveredMessage(
        { at: DECIDED_AT + 2 * MINUTE, downMs: 2 * MINUTE, resumeAt: null },
        options,
      ).telegram.text,
    },
    {
      name: 'ENGINE_PAUSED',
      text: enginePausedMessage({ at: DECIDED_AT, until: DECIDED_AT + 30 * MINUTE }, options)
        .telegram.text,
    },
    {
      name: 'NEWS_UPCOMING',
      text: newsUpcomingMessage(
        { event: CPI, now: CPI_AT - 30 * MINUTE, window: { before: 45, after: 20 } },
        options,
      ).telegram.text,
    },
    {
      name: 'NEWS_RELEASED',
      text: newsReleasedMessage(
        {
          event: { ...CPI, actual: 0.5, actualFirstSeenAt: CPI_AT + 3_000 },
          sigma: 2.14,
          goldAfter: { seconds: 15, moveUsd: -3.1, spread: 0.9 },
          opensWindow: true,
        },
        options,
      ).telegram.text,
    },
    {
      name: 'NEWS_HEADLINE',
      text: newsHeadlineMessage(
        {
          cluster: STORY,
          detectedAt: DECIDED_AT,
          since: { usd: 2.4, atr: 0.8, spread: 0.12 },
          history: { topic: 'FED_RATES', impact: 'HIGH', n: 64, share: 0.42, baseline: 0.18 },
        },
        options,
      ).telegram.text,
    },
    {
      name: 'MARKET_MOVE, with possible causes',
      text: marketMoveMessage(
        {
          detection: SPIKE,
          spread: 0.2,
          causes: possibleCauses([STORY], [OTHER_STORY], DECIDED_AT),
          feed: 'AVAILABLE',
          open: [{ seq: 46, side: 'BUY', unrealisedR: 1.4 }],
        },
        options,
      ).telegram.text,
    },
    {
      name: 'MARKET_MOVE, no matching headline',
      text: marketMoveMessage(
        { detection: SPIKE, spread: 0.2, causes: [], feed: 'AVAILABLE', open: [] },
        options,
      ).telegram.text,
    },
    {
      name: 'SYSTEM_DEGRADED, the headline feeds',
      text: headlineFeedsDownMessage({ since: DECIDED_AT, silentMs: 11 * MINUTE }, options).telegram
        .text,
    },
    {
      name: 'SYSTEM_RECOVERED, the headline feeds',
      text: headlineFeedsBackMessage({ at: DECIDED_AT + 13 * MINUTE, downMs: 13 * MINUTE }, options)
        .telegram.text,
    },
    {
      name: 'STORAGE_WARNING',
      text: storageWarningMessage(
        { usedPercent: 82, budgetGb: 10, retentionDays: 3, largestTable: 'ticks', largestGb: 4.7 },
        options,
      ).telegram.text,
    },
    {
      name: 'DAILY_DIGEST',
      text: dailyDigestMessage({ label: tradingDayOf(DECIDED_AT).label, rows: DAY_ROWS }, options)
        .telegram.text,
    },
    {
      name: 'MONTHLY_REPORT',
      text: monthlyReportMessage(
        {
          monthStart: monthWindow(DECIDED_AT, options.displayTz).from,
          rows: monthRows(),
          feed: { incidents: 3, uptime: 0.992 },
          dbSizeBytes: 1_140_000_000,
          lastBackupAgeMs: 5 * 60 * MINUTE,
        },
        options,
      ).telegram.text,
    },
    { name: 'TEST', text: testMessage(DECIDED_AT, options).telegram.text },
  ];
}

export const PREVIEW_INTRO =
  'SAMPLES FOR FORMAT REVIEW. Every message after this one is made up from fixed example data. None of it is a real signal or advice.';

export interface PreviewDeps {
  readonly client: Pick<TelegramClient, 'getMe' | 'getUpdates' | 'sendMessage'>;
  readonly options: DisplayOptions;
  readonly print: (line: string) => void;
  /** How long to wait for the owner to press START, in milliseconds. */
  readonly waitMs?: number;
  /** Seconds one long poll waits. */
  readonly pollS?: number;
  /** The least time between two messages. */
  readonly gapMs?: number;
  readonly now?: () => number;
  /** For tests: what waits between two messages. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * `pnpm cli telegram:preview`: waits for a private `/start` to the bot, then sends the samples to
 * that chat. It needs only the bot token, no database and no running worker, so the owner can look
 * at the formats on the phone before anything else is set up. It does not link the chat: the
 * link flow (`telegram:link`) is separate, and a sample is never a reason to serve a chat. Returns
 * how many messages it sent.
 */
export async function telegramPreview(deps: PreviewDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const me = await deps.client.getMe();
  const bot = me.username === null ? 'your bot' : `https://t.me/${me.username}`;
  deps.print(`Open ${bot} in Telegram and press START (or send /start). I wait for it.`);

  const deadline = now() + (deps.waitMs ?? 120_000);
  let offset: number | null = null;
  let chatId: number | null = null;
  while (chatId === null) {
    if (now() >= deadline) throw new Error('no /start came in time: run the command again');
    const updates = await deps.client.getUpdates({ offset, timeoutS: deps.pollS ?? 10 });
    for (const update of updates) {
      offset = update.updateId + 1;
      const { message } = update;
      if (message?.chatType !== 'private') continue;
      if (parseCommand(message.text)?.command === 'start') chatId = message.chatId;
    }
  }
  // what was read is confirmed, so that a worker that starts later does not see it again
  await deps.client.getUpdates({ offset, timeoutS: 0 });
  deps.print('Got it. Sending the samples (about one every second).');

  const transport = new TelegramTransport({
    client: deps.client,
    minGapMs: deps.gapMs ?? 1000,
    now,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  const samples = sampleMessages(deps.options);
  await transport.sendWhenReady(chatId, PREVIEW_INTRO);
  let sent = 1;
  for (const [index, sample] of samples.entries()) {
    const label = `[SAMPLE ${String(index + 1)}/${String(samples.length)}: ${sample.name}, not a real signal]`;
    await transport.sendWhenReady(chatId, `${label}\n\n${sample.text}`);
    sent += 1;
  }
  deps.print(`Sent ${String(sent)} messages. Check them in Telegram.`);
  return sent;
}
