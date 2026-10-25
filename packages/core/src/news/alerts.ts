import {
  systemChannels,
  systemMessage,
  systemOutboxRows,
  type SystemMessage,
} from '../alerts/system';
import { ALERT_WORDS } from '../alerts/words';
import type { MoveSince } from './impact';
import type { NewsFeedState, NewsImpact, NewsTopic, Side } from '../domain';
import { percentText, signedPriceText, priceText, signedRText, spanText } from '../explain/format';
import { displayOptionsOf, type AlertSettings, type OutboxRow } from '../lifecycle/alerts';
import { signalTag } from '../messages/common';
import { bold, clean } from '../messages/markup';
import { ICON, sideIcon } from '../messages/style';
import { clockText } from '../messages/time';
import type { DisplayOptions } from '../messages/types';
import { HEADLINE_ALERT_MAX_AGE_MS, timeOf, type Cause, type HeadlineCluster } from './context';
import type { MoveDetection } from './move';

// The messages about headlines and sudden moves of gold (04_API_and_Notifications section 4.1):
// NEWS_HEADLINE, MARKET_MOVE, and the notice that the headline feeds are down or back. Every one
// of them says "possible cause" and shows measured numbers; none claims that a headline caused a move.

/** A headline alert and a move alert are worth sending for this long (04, "Delivery rules"). */
export const NEWS_ALERT_TTL_MS = 30 * 60_000;
/** A topic history line needs at least this many measured headlines (`stats.minN`). */
export const TOPIC_HISTORY_MIN_N = 30;

const RANK: Readonly<Record<NewsImpact, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export const impactAtLeast = (impact: NewsImpact, minimum: NewsImpact): boolean =>
  RANK[impact] >= RANK[minimum];

export const headlineEventKey = (clusterId: string): string => `news:${clusterId}:headline`;
export const moveEventKey = (id: number): string => `move:${String(id)}:spike`;

/** `health:HEADLINES@1792735320000:degraded`: named by the start of the outage, which survives a restart. */
export const headlineHealthEventKey = (
  startedAt: number,
  phase: 'degraded' | 'recovered',
): string => `health:HEADLINES@${String(startedAt)}:${phase}`;

// -------------------------------------------------------------------------------- NEWS_HEADLINE

/** What gold's history says about the topic of a headline at its impact (`news_topic_stats`). */
export interface TopicHistory {
  readonly topic: NewsTopic;
  readonly impact: NewsImpact;
  readonly n: number;
  /** The share of headlines after which gold moved 1 ATR or more within 10 minutes. */
  readonly share: number;
  /** The same share over ordinary windows; null when it cannot be told. */
  readonly baseline: number | null;
}

export interface HeadlineAlertData {
  readonly cluster: HeadlineCluster;
  /** When the story was detected (now). */
  readonly detectedAt: number;
  /** Gold since publication; null when no tick could measure it. */
  readonly since: MoveSince | null;
  readonly history: TopicHistory | null;
}

/** The story is fresh enough to be news: at most 30 minutes old by its published time (or first seen). */
export function headlineAlertDue(cluster: HeadlineCluster, now: number): boolean {
  const age = now - timeOf(cluster);
  return age >= 0 && age <= HEADLINE_ALERT_MAX_AGE_MS;
}

/** Whether a story is told: at least the impact of the settings, and at least one of its topics is on. */
export function headlineTold(settings: AlertSettings, cluster: HeadlineCluster): boolean {
  return (
    impactAtLeast(cluster.impact, settings.newsAlerts.minImpact) &&
    cluster.topics.some((topic) => settings.newsAlerts.topics[topic] === 'on')
  );
}

export function newsHeadlineMessage(
  data: HeadlineAlertData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const { cluster, detectedAt } = data;
  const at = (ms: number): string => clockText(ms, options.displayTz, detectedAt);
  const topics = cluster.topics.map((topic) => w.topicName[topic]).join(', ');
  const title = clean(cluster.title);
  const sources = cluster.sources.map((source) => clean(source.name)).join(', ');
  const published = cluster.publishedAt;
  const delay = published === null ? null : spanText(Math.max(0, detectedAt - published));

  const lines = [
    `${ICON.news} ${bold(w.headlineTitle(cluster.impact, topics))}`,
    `"${title}"`,
    w.headlineSeen(sources, published === null ? null : at(published), at(detectedAt), delay),
    data.since === null
      ? w.goldSinceNone
      : w.goldSince(
          signedPriceText(data.since.usd),
          data.since.atr === null ? null : data.since.atr.toFixed(1),
          data.since.spread === null ? null : priceText(data.since.spread),
        ),
  ];
  const history = data.history;
  if (history !== null && history.n >= TOPIC_HISTORY_MIN_N) {
    lines.push(
      w.topicHistory(
        w.impactName[history.impact],
        w.topicName[history.topic],
        percentText(history.share),
        history.n,
        history.baseline === null ? null : percentText(history.baseline),
      ),
    );
  } else {
    lines.push(w.topicHistoryNone);
  }
  lines.push(w.headlineLink(cluster.url), w.headlineNote);
  return systemMessage('NEWS_HEADLINE', lines, {
    title: `HEADLINE (${cluster.impact}): ${ALERT_WORDS.en.topicName[cluster.topics[0] ?? 'GOLD_DIRECT']}`,
    body: title,
    urgency: 'normal',
    url: '/news?tab=headlines',
  });
}

/** The rows of NEWS_HEADLINE: one for each channel that is told, valid for 30 minutes. */
export function newsHeadlineRows(
  data: HeadlineAlertData,
  settings: AlertSettings,
  now: number,
): OutboxRow[] {
  if (!headlineTold(settings, data.cluster)) return [];
  return systemOutboxRows(
    newsHeadlineMessage(data, displayOptionsOf(settings)),
    headlineEventKey(data.cluster.id),
    systemChannels(settings, 'NEWS_HEADLINE'),
    now,
    NEWS_ALERT_TTL_MS,
  );
}

// -------------------------------------------------------------------------------- MARKET_MOVE

/** An open signal as the move message lists it. */
export interface OpenSignalLine {
  readonly seq: number;
  readonly side: Side;
  /** The result in R if closed now; null without a price. */
  readonly unrealisedR: number | null;
}

export interface MarketMoveData {
  readonly detection: MoveDetection;
  /** The spread of the latest tick; null when it is not known. */
  readonly spread: number | null;
  readonly causes: readonly Cause[];
  /** Whether "no headline" can be said: it cannot while the headline feeds are down. */
  readonly feed: NewsFeedState;
  readonly open: readonly OpenSignalLine[];
}

export function marketMoveMessage(data: MarketMoveData, options: DisplayOptions): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const { detection } = data;
  const up = detection.kind === 'SPIKE_UP';
  const sign = up ? 1 : -1;
  const span = spanText(detection.windowS * 1000);
  const at = (ms: number): string => clockText(ms, options.displayTz, detection.at);

  const lines = [
    `${up ? ICON.spikeUp : ICON.spikeDown} ${bold(
      w.moveTitle(
        up ? 'UP' : 'DOWN',
        signedPriceText(sign * detection.moveUsd),
        span,
        detection.moveAtr.toFixed(1),
        detection.basis,
        data.spread === null ? null : priceText(data.spread),
        at(detection.at),
      ),
    )}`,
  ];
  if (data.causes.length > 0) {
    lines.push(w.causesTitle);
    data.causes.forEach((cause, index) => {
      const { headline } = cause;
      const sources = headline.sources.map((name) => clean(name)).join(', ');
      const title = clean(headline.title);
      lines.push(
        headline.classified && headline.impact !== null
          ? w.causeLine(index + 1, w.impactName[headline.impact], title, sources, at(cause.at))
          : w.causeUnclassified(index + 1, title, sources, at(cause.at)),
      );
    });
  } else {
    lines.push(data.feed === 'UNAVAILABLE' ? w.causesUnavailable : w.noCause);
  }
  lines.push(
    w.moveOpen(
      data.open.length === 0
        ? null
        : data.open
            .map(
              (line) =>
                `${sideIcon(line.side)} ${signalTag(line.seq)} ${line.side}${line.unrealisedR === null ? '' : ` (${signedRText(line.unrealisedR)})`}`,
            )
            .join(', '),
    ),
  );
  return systemMessage('MARKET_MOVE', lines, {
    title: `GOLD SPIKE ${up ? 'UP' : 'DOWN'} ${signedPriceText(sign * detection.moveUsd)} USD`,
    body: `${detection.moveAtr.toFixed(1)} x ATR ${detection.basis} in ${span}.`,
    urgency: 'high',
    url: '/news?tab=moves',
  });
}

/** The rows of MARKET_MOVE: none when the owner switched move alerts off; valid for 30 minutes. */
export function marketMoveRows(
  data: MarketMoveData,
  eventId: number,
  settings: AlertSettings,
  now: number,
): OutboxRow[] {
  if (settings.newsAlerts.marketMoves !== 'on') return [];
  return systemOutboxRows(
    marketMoveMessage(data, displayOptionsOf(settings)),
    moveEventKey(eventId),
    systemChannels(settings, 'MARKET_MOVE'),
    now,
    NEWS_ALERT_TTL_MS,
  );
}

// ------------------------------------------------------------------------------ headline feeds

export interface HeadlineFeedsDownData {
  /** When the last feed went silent. */
  readonly since: number;
  readonly silentMs: number;
}

export function headlineFeedsDownMessage(
  data: HeadlineFeedsDownData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const since = clockText(data.since, options.displayTz);
  return systemMessage(
    'SYSTEM_DEGRADED',
    [
      `${ICON.feedDown} ${bold(w.headlineFeedsDownTitle(since))} ${w.headlineFeedsSilent(spanText(data.silentMs))}`,
      w.headlineFeedsDownBody,
    ],
    {
      title: 'HEADLINE FEEDS DOWN',
      body: `Since ${since}. Headline alerts are unavailable.`,
      urgency: 'normal',
      url: '/news?tab=headlines',
    },
  );
}

export interface HeadlineFeedsBackData {
  readonly at: number;
  readonly downMs: number;
}

export function headlineFeedsBackMessage(
  data: HeadlineFeedsBackData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const at = clockText(data.at, options.displayTz);
  return systemMessage(
    'SYSTEM_RECOVERED',
    [
      `${ICON.feedUp} ${bold(w.headlineFeedsBackTitle(at, spanText(data.downMs)))}`,
      w.headlineFeedsBackBody,
    ],
    {
      title: 'HEADLINE FEEDS BACK',
      body: `At ${at}, after ${spanText(data.downMs)}.`,
      urgency: 'normal',
      url: '/news?tab=headlines',
    },
  );
}
