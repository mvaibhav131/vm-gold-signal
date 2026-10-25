import { EVIDENCE_MIN_SAMPLE } from '../evidence';
import type {
  CauseCode,
  FeedState,
  Regime,
  Result,
  Session,
  Side,
  StrategyKey,
  StrategyStatus,
} from '../domain';
import { REGIME_NAMES, SESSION_NAMES, STRATEGY_NAMES } from '../explain/names';
import {
  fixedText,
  intervalText,
  plainRText,
  priceText,
  signedRText,
  spanText,
} from '../explain/format';
import { clockText, SHORT_MONTHS, zoneName } from '../messages/time';
import { signalTag } from '../messages/common';
import { bold, clean, renderHtml } from '../messages/markup';
import { ICON, FEED_ICON, RESULT_ICON, sideIcon } from '../messages/style';
import { TELEGRAM_HARD_LIMIT, TELEGRAM_SOFT_LIMIT } from '../messages/text';
import type { DisplayOptions } from '../messages/types';
import { summarizeResults } from '../stats/metrics';
import type { StatsRecord } from '../stats/counts';
import { zonedParts } from '../time/zone';
import { ALERT_WORDS, MONTH_NAMES, type AlertWords } from './words';

/** What the bot sends back: Telegram HTML, escaped as a whole with the few tags of `messages/markup`. */
export interface Reply {
  readonly text: string;
}

/** Escapes the lines of a reply as a whole and refuses one that Telegram would not take. */
export function replyOf(lines: readonly string[]): Reply {
  const text = renderHtml(lines.join('\n'));
  if (text.length > TELEGRAM_HARD_LIMIT) {
    throw new RangeError(`a reply of ${String(text.length)} characters is too long for Telegram`);
  }
  return { text };
}

/**
 * The lines of a list, as many as fit under the soft limit; what does not fit becomes one "and N
 * more" line, so that a long list never makes a reply that Telegram would refuse.
 */
function fitList(
  head: readonly string[],
  items: readonly string[],
  tail: readonly string[],
  more: (count: number) => string,
): string[] {
  const build = (count: number): string[] => [
    ...head,
    ...items.slice(0, count),
    ...(count < items.length ? [more(items.length - count)] : []),
    ...tail,
  ];
  let count = items.length;
  while (count > 0 && renderHtml(build(count).join('\n')).length > TELEGRAM_SOFT_LIMIT) count -= 1;
  return build(count);
}

const wordsOf = (options: DisplayOptions): AlertWords => ALERT_WORDS[options.locale];

// ---------------------------------------------------------------------------------- help, start, link

export function helpReply(options: DisplayOptions): Reply {
  const w = wordsOf(options);
  const order = ['status', 'open', 'last', 'today', 'month', 'pause', 'resume', 'help'] as const;
  return replyOf([
    `${ICON.help} ${bold(w.helpTitle)}`,
    ...order.map((command) => w.helpLine[command]),
    w.helpNote,
  ]);
}

export const startReply = (options: DisplayOptions): Reply => replyOf([wordsOf(options).startText]);
export const unknownCommandReply = (name: string, options: DisplayOptions): Reply =>
  replyOf([wordsOf(options).unknownCommand(name)]);
export const linkedReply = (options: DisplayOptions): Reply => replyOf([wordsOf(options).linked]);
export const linkInvalidReply = (options: DisplayOptions): Reply =>
  replyOf([wordsOf(options).linkInvalid]);
export const pauseUsageReply = (options: DisplayOptions): Reply =>
  replyOf([wordsOf(options).pauseUsage]);
export const noClosedReply = (options: DisplayOptions): Reply =>
  replyOf([wordsOf(options).noClosedYet]);

// ---------------------------------------------------------------------------------------- /status

export type EngineFacts =
  | { readonly status: 'RUNNING' }
  | { readonly status: 'PAUSED'; readonly since: number; readonly until: number | null }
  | { readonly status: 'WARMING_UP'; readonly progressPct: number };

export interface StatusData {
  readonly at: number;
  /** Null when the feed state is not known (the feed is not in this process). */
  readonly feed: {
    readonly state: FeedState;
    readonly tickAgeMs: number | null;
    readonly spread: number | null;
  } | null;
  readonly engine: EngineFacts;
  readonly session: Session;
  /** Null until the decision engine reports one. */
  readonly regime: Regime | null;
  readonly nextHigh: { readonly name: string; readonly at: number } | null;
  readonly openCount: number;
  readonly openRiskR: number;
  readonly strategies: readonly {
    readonly key: StrategyKey;
    readonly version: string;
    readonly status: StrategyStatus;
    readonly alerts: boolean;
  }[];
}

export function statusReply(data: StatusData, options: DisplayOptions): Reply {
  const w = wordsOf(options);
  const at = (ms: number) => clockText(ms, options.displayTz, data.at);
  const lines = [`${ICON.status} ${bold(w.statusTitle(clockText(data.at, options.displayTz)))}`];

  if (data.feed === null) {
    lines.push(`${ICON.noData} ${w.feedLine(w.notAvailable, '')}`);
  } else {
    const detail =
      data.feed.tickAgeMs === null
        ? w.noTickYet
        : [
            w.lastTick(spanText(data.feed.tickAgeMs)),
            ...(data.feed.spread === null ? [] : [w.spreadOf(priceText(data.feed.spread))]),
          ].join(', ');
    lines.push(
      `${FEED_ICON[data.feed.state]} ${w.feedLine(w.feedStateName[data.feed.state], detail)}`,
    );
  }

  const { engine } = data;
  if (engine.status === 'RUNNING') lines.push(`${ICON.running} ${w.engineRunning}`);
  else if (engine.status === 'WARMING_UP')
    lines.push(`${ICON.weak} ${w.engineWarming(String(Math.round(engine.progressPct)))}`);
  else {
    lines.push(`${ICON.paused} ${w.enginePausedSince(at(engine.since))}`);
    if (engine.until !== null)
      lines.push(w.pausedUntil(at(engine.until), spanText(Math.max(0, engine.until - data.at))));
  }

  lines.push(
    w.sessionRegime(
      SESSION_NAMES[data.session],
      data.regime === null ? null : REGIME_NAMES[data.regime],
    ),
  );
  lines.push(
    `${ICON.macro} ${
      data.nextHigh === null
        ? w.noNextHigh
        : w.nextHigh(
            clean(data.nextHigh.name),
            at(data.nextHigh.at),
            spanText(Math.max(0, data.nextHigh.at - data.at)),
          )
    }`,
  );
  lines.push(`${ICON.open} ${w.openSummary(data.openCount, plainRText(data.openRiskR))}`);
  lines.push(bold(w.strategiesTitle));
  for (const strategy of data.strategies) {
    lines.push(
      w.strategyLine(
        STRATEGY_NAMES[strategy.key],
        strategy.version,
        w.strategyStatusName[strategy.status],
        strategy.alerts,
      ),
    );
  }
  return replyOf(lines);
}

// ------------------------------------------------------------------------------------------ /open

export interface OpenLine {
  readonly seq: number;
  readonly side: Side;
  readonly strategyKey: StrategyKey;
  readonly status: 'ACTIVE' | 'TP1_HIT';
  /** The closing-side price now (bid for a BUY, ask for a SELL); null when no tick is known. */
  readonly price: number | null;
  /** The result in R if closed now (`unrealisedR`); null without a price. */
  readonly unrealisedR: number | null;
  readonly entry: number;
  /** The stop in force: the stop-loss, or the entry after TP1. */
  readonly stop: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly timeStopAt: number;
}

export interface OpenData {
  readonly at: number;
  readonly lines: readonly OpenLine[];
  /** Why no new signal is coming, as the engine says it (the dashboard's WAIT reasons). */
  readonly waitReasons: readonly string[];
}

export function openReply(data: OpenData, options: DisplayOptions, openRisk: number): Reply {
  const w = wordsOf(options);
  if (data.lines.length === 0) {
    return replyOf([
      w.noOpen,
      ...(data.waitReasons.length === 0 ? [] : [w.waiting(data.waitReasons.join(', '))]),
    ]);
  }
  const rows = data.lines.map((line) => {
    const r = line.unrealisedR === null ? w.noPrice : signedRText(line.unrealisedR);
    const price = line.price === null ? w.noPrice : priceText(line.price);
    const timeStop = clockText(line.timeStopAt, options.displayTz, data.at);
    const tag = signalTag(line.seq);
    const strategy = STRATEGY_NAMES[line.strategyKey];
    return `${sideIcon(line.side)} ${
      line.status === 'ACTIVE'
        ? w.openActive(
            tag,
            line.side,
            strategy,
            r,
            price,
            priceText(line.stop),
            priceText(line.tp1),
            timeStop,
          )
        : w.openAfterTp1(
            tag,
            line.side,
            strategy,
            r,
            price,
            priceText(line.stop),
            priceText(line.tp2 ?? line.tp1),
            timeStop,
          )
    }`;
  });
  return replyOf(
    fitList(
      [`${ICON.open} ${bold(w.openTitle(data.lines.length, plainRText(openRisk)))}`],
      rows,
      [],
      w.moreSignals,
    ),
  );
}

// ------------------------------------------------------------------------------ /today and /month

/** One signal of the period, from its creation to its result (null result: still open). */
export interface PeriodRow {
  readonly seq: number;
  readonly side: Side;
  readonly strategyKey: StrategyKey;
  readonly generatedAt: number;
  readonly result: Result | null;
  readonly countsInStats: boolean;
  readonly realizedRNet: number | null;
  readonly durationS: number;
  readonly tp1Hit: boolean;
  readonly tp2Hit: boolean;
  readonly closedAt: number;
  readonly primaryCause: CauseCode | null;
}

const statsRecordOf = (row: PeriodRow): StatsRecord | null =>
  row.result === null
    ? null
    : {
        result: row.result,
        countsInStats: row.countsInStats,
        realizedRNet: row.realizedRNet,
        durationS: row.durationS,
        tp1Hit: row.tp1Hit,
        tp2Hit: row.tp2Hit,
        closedAt: row.closedAt,
      };

const recordsOf = (rows: readonly PeriodRow[]): StatsRecord[] =>
  rows.flatMap((row) => {
    const record = statsRecordOf(row);
    return record === null ? [] : [record];
  });

function stateText(row: PeriodRow, w: AlertWords): string {
  if (row.result === null) return w.stateOpen;
  if (row.result === 'CANCELLED') return w.stateCancelled;
  if (row.result === 'DATA_INVALID') return w.stateInvalid;
  return `${row.result.replace('_', ' ')} ${signedRText(row.realizedRNet ?? 0)}`;
}

const rateOf = (share: number): string => `${fixedText(share * 100, 1)}%`;

/** Net R of the counted results, with the sign shown as the messages show it. */
const netText = (summary: ReturnType<typeof summarizeResults>): string => signedRText(summary.netR);

export function todayReply(
  data: { readonly at: number; readonly rows: readonly PeriodRow[] },
  options: DisplayOptions,
): Reply {
  const w = wordsOf(options);
  const parts = zonedParts(data.at, options.displayTz);
  const date = `${String(parts.day)} ${SHORT_MONTHS[parts.month - 1] ?? ''}`;
  const head = [`${ICON.today} ${bold(w.todayTitle(date, zoneName(options.displayTz, data.at)))}`];
  if (data.rows.length === 0) return replyOf([...head, w.noSignalsToday]);

  const summary = summarizeResults(recordsOf(data.rows));
  const open = data.rows.filter((row) => row.result === null).length;
  head.push(w.generated(data.rows.length));
  head.push(
    `${w.validResults(summary.resolvedValid)}. ${w.resultCounts(summary.wins, summary.partials, summary.losses, summary.timeExits)}`,
  );
  head.push(w.apartCounts(summary.cancelled, summary.dataInvalid, open));
  const tail = [bold(w.netLine(netText(summary)))];
  const rows = [...data.rows]
    .sort((a, b) => a.seq - b.seq)
    .map(
      (row) =>
        `${RESULT_ICON[row.result ?? 'PENDING']} ${w.signalLine(
          signalTag(row.seq),
          row.side,
          STRATEGY_NAMES[row.strategyKey],
          stateText(row, w),
        )}`,
    );
  return replyOf(fitList(head, rows, tail, w.moreSignals));
}

export function monthReply(
  data: { readonly monthStart: number; readonly rows: readonly PeriodRow[] },
  options: DisplayOptions,
): Reply {
  const w = wordsOf(options);
  const parts = zonedParts(data.monthStart, options.displayTz);
  const lines = [
    `${ICON.month} ${bold(w.monthTitle(MONTH_NAMES[parts.month - 1] ?? '', String(parts.year)))}`,
  ];
  const summary = summarizeResults(recordsOf(data.rows));
  const open = data.rows.filter((row) => row.result === null).length;

  lines.push(w.generated(data.rows.length));
  lines.push(w.apartCounts(summary.cancelled, summary.dataInvalid, open));
  lines.push(w.validResults(summary.resolvedValid));
  if (summary.resolvedValid === 0) return replyOf(lines);

  lines.push(w.resultCounts(summary.wins, summary.partials, summary.losses, summary.timeExits));
  if (summary.winRate !== null && summary.ci95 !== null) {
    lines.push(
      w.rateLine(
        rateOf(summary.winRate),
        summary.winners,
        summary.resolvedValid,
        intervalText(summary.ci95),
      ),
    );
  } else {
    lines.push(w.rateHidden(summary.resolvedValid, EVIDENCE_MIN_SAMPLE));
  }
  lines.push(
    w.moneyLine(
      netText(summary),
      summary.expectancyR === null ? '-' : signedRText(summary.expectancyR),
      summary.profitFactor === null ? '-' : fixedText(summary.profitFactor, 2),
      summary.maxDrawdownR === 0 ? plainRText(0) : signedRText(-summary.maxDrawdownR),
    ),
  );

  const byStrategy = new Map<StrategyKey, PeriodRow[]>();
  for (const row of data.rows) {
    if (row.result === null || !row.countsInStats) continue;
    byStrategy.set(row.strategyKey, [...(byStrategy.get(row.strategyKey) ?? []), row]);
  }
  const strategies = [...byStrategy.entries()]
    .map(([key, rows]) => ({ key, rows, summary: summarizeResults(recordsOf(rows)) }))
    .sort(
      (a, b) =>
        b.rows.length - a.rows.length || STRATEGY_NAMES[a.key].localeCompare(STRATEGY_NAMES[b.key]),
    );
  lines.push(bold(w.byStrategy));
  for (const item of strategies) {
    lines.push(
      w.strategyCount(
        STRATEGY_NAMES[item.key],
        item.rows.length,
        item.summary.winRate === null ? null : rateOf(item.summary.winRate),
      ),
    );
  }

  const causes = new Map<CauseCode, number>();
  for (const row of data.rows) {
    if (row.primaryCause !== null)
      causes.set(row.primaryCause, (causes.get(row.primaryCause) ?? 0) + 1);
  }
  const top = [...causes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  lines.push(
    top.length === 0
      ? w.noReviewed
      : `${w.topCauses} ${top.map(([code, n]) => `${code} ${String(n)}`).join(', ')}`,
  );
  return replyOf(lines);
}
