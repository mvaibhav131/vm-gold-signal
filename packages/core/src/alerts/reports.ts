import { QUALITY_GROUPS, SESSIONS, type QualityGroup, type Session } from '../domain';
import { EVIDENCE_MIN_SAMPLE } from '../evidence';
import { GROUP_NAMES, SESSION_NAMES } from '../explain/names';
import { fixedText, signedRText, spanText } from '../explain/format';
import { bold } from '../messages/markup';
import { ICON } from '../messages/style';
import { SHORT_MONTHS } from '../messages/time';
import type { DisplayOptions } from '../messages/types';
import { summarizeResults } from '../stats/metrics';
import { zonedParts } from '../time/zone';
import { monthLines, rateOf, recordsOf, type PeriodRow } from './replies';
import { systemMessage, type SystemMessage } from './system';
import { ALERT_WORDS, MONTH_NAMES } from './words';

// The two reports that come without being asked: the summary of a trading day and the report of a month
// (04_API_and_Notifications sections 4.1 and 4.2). They are made of the same rows and the same lines as `/today` and `/month`.

/** A day's report is worth sending for 12 hours, a month's for 3 days (04, "Delivery rules"). */
export const DAILY_DIGEST_TTL_MS = 12 * 3_600_000;
export const MONTHLY_REPORT_TTL_MS = 3 * 86_400_000;

/** A signal of the period with what the reports need besides the lines of `/today`: its session, its score and the groups that were weak at entry. */
export interface ReportRow extends PeriodRow {
  readonly session: Session;
  readonly qualityScore: number;
  /** The groups that were `WEAK` or `FAIL` at entry, from the review of the result; empty when it was not reviewed. */
  readonly weakGroups: readonly QualityGroup[];
}

/** `report:daily:20261023`: named by the trading day, which is the same after a restart. */
export const dailyDigestEventKey = (label: string): string =>
  `report:daily:${label.replaceAll('-', '')}`;

/** `report:monthly:202610`. */
export const monthlyReportEventKey = (year: number, month: number): string =>
  `report:monthly:${String(year)}${String(month).padStart(2, '0')}`;

const RESULTS_SHOWN = ['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT'] as const;

export interface DigestData {
  /** The trading day, named by the New York date on which it ends: `2026-10-23`. */
  readonly label: string;
  /** The signals decided in the trading day. */
  readonly rows: readonly ReportRow[];
}

/** The group that was weak at entry in most of the day's reviewed results (the first of the list on a tie), or null. */
function topWeakGroup(rows: readonly ReportRow[]): QualityGroup | null {
  const counts = new Map<QualityGroup, number>();
  for (const row of rows) {
    for (const group of row.weakGroups) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  let best: QualityGroup | null = null;
  for (const group of QUALITY_GROUPS) {
    const n = counts.get(group) ?? 0;
    if (n > 0 && (best === null || n > (counts.get(best) ?? 0))) best = group;
  }
  return best;
}

/** DAILY_DIGEST: what the trading day did, in a few lines: the signals, the valid results with their R, what is still open, and the weakest group. */
export function dailyDigestMessage(data: DigestData, options: DisplayOptions): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const [, month = '1', day = '1'] = data.label.split('-');
  const date = `${String(Number(day))} ${SHORT_MONTHS[Number(month) - 1] ?? ''}`;
  const summary = summarizeResults(recordsOf(data.rows));
  const open = data.rows.filter((row) => row.result === null).length;
  const parts = RESULTS_SHOWN.flatMap((result) => {
    const mine = data.rows.filter((row) => row.result === result && row.countsInStats);
    if (mine.length === 0) return [];
    const net = mine.reduce((sum, row) => sum + (row.realizedRNet ?? 0), 0);
    return [w.digestPart(mine.length, w.resultNames[result], signedRText(net))];
  });

  const lines = [
    `${ICON.today} ${bold(w.digestTitle(date))}: ${w.digestCounts(data.rows.length, summary.resolvedValid, parts.join(', '), open)}`,
  ];
  if (summary.cancelled > 0 || summary.dataInvalid > 0) {
    lines.push(w.digestNotCounted(summary.cancelled, summary.dataInvalid));
  }
  if (summary.resolvedValid > 0) lines.push(bold(w.netLine(signedRText(summary.netR))));
  const weak = topWeakGroup(data.rows);
  if (weak !== null) lines.push(w.digestWeakGroup(GROUP_NAMES[weak]));
  return systemMessage('DAILY_DIGEST', lines, {
    title: w.digestTitle(date),
    body: `${String(summary.resolvedValid)} valid results, net ${signedRText(summary.netR)}.`,
    urgency: 'normal',
    url: '/analytics',
  });
}

export interface MonthlyReportData {
  /** The first instant of the month in the display time zone. */
  readonly monthStart: number;
  /** The signals decided in the month. */
  readonly rows: readonly ReportRow[];
  /** The incidents of the feed in the month (the feed going silent or away), and the share of the trading time it was there; null when it cannot be told. */
  readonly feed: { readonly incidents: number; readonly uptime: number | null };
  readonly dbSizeBytes: number | null;
  /** How long ago the last backup was made; null when no backup is known (it is left out). */
  readonly lastBackupAgeMs: number | null;
}

/** A backup younger than this is "OK" (the backup is nightly, 06_Phases_and_Setup B31, so a day and a half is a missed night). */
const BACKUP_OK_MS = 36 * 3_600_000;

const winnersOf = (rows: readonly ReportRow[]): number =>
  rows.filter((row) => row.countsInStats && (row.realizedRNet ?? 0) > 0).length;

/** The session with the best win rate and the one with the worst (the larger sample first on a tie): both, or only the best when there is one session. */
function bestAndWorstSession(
  rows: readonly ReportRow[],
): { session: Session; n: number; rate: number }[] {
  const counted = rows.filter((row) => row.result !== null && row.countsInStats);
  const stats = SESSIONS.flatMap((session) => {
    const mine = counted.filter((row) => row.session === session);
    return mine.length === 0
      ? []
      : [{ session, n: mine.length, rate: winnersOf(mine) / mine.length }];
  });
  if (stats.length === 0) return [];
  const best = [...stats].sort((a, b) => b.rate - a.rate || b.n - a.n)[0];
  const worst = [...stats].sort((a, b) => a.rate - b.rate || b.n - a.n)[0];
  if (best === undefined || worst === undefined) return [];
  return stats.length === 1 || best.session === worst.session ? [best] : [best, worst];
}

const SCORE_BANDS = [
  { label: '75+', test: (score: number) => score >= 75 },
  { label: '65-74', test: (score: number) => score >= 65 && score < 75 },
  { label: 'under 65', test: (score: number) => score < 65 },
] as const;

/** MONTHLY_REPORT: the lines of `/month` for a whole month, then the best and the worst session, the score check and the data line. */
export function monthlyReportMessage(
  data: MonthlyReportData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const parts = zonedParts(data.monthStart, options.displayTz);
  const month = MONTH_NAMES[parts.month - 1] ?? '';
  const summary = summarizeResults(recordsOf(data.rows));
  const lines = [
    `${ICON.month} ${bold(w.reportTitle(month, String(parts.year)))}`,
    ...monthLines(data.rows, options),
  ];

  const sessions = bestAndWorstSession(data.rows);
  const text = (item: { session: Session; n: number; rate: number }): string =>
    w.sessionPart(
      SESSION_NAMES[item.session],
      rateOf(item.rate),
      item.n,
      item.n < EVIDENCE_MIN_SAMPLE,
    );
  const [best, worst] = sessions;
  if (best !== undefined)
    lines.push(w.reportSessions(text(best), worst === undefined ? null : text(worst)));

  const counted = data.rows.filter((row) => row.result !== null && row.countsInStats);
  const bands = SCORE_BANDS.flatMap((band) => {
    const mine = counted.filter((row) => band.test(row.qualityScore));
    return mine.length === 0
      ? []
      : [w.scorePart(band.label, rateOf(winnersOf(mine) / mine.length), mine.length)];
  });
  if (bands.length > 0) lines.push(w.reportScore(bands.join('; ')));

  const items = [
    w.dataFeed(
      data.feed.uptime === null ? null : `${fixedText(data.feed.uptime * 100, 1)}%`,
      data.feed.incidents,
    ),
    ...(data.dbSizeBytes === null
      ? []
      : [w.dataStorage(`${fixedText(data.dbSizeBytes / 1e9, 1)} GB`)]),
    ...(data.lastBackupAgeMs === null
      ? []
      : [
          data.lastBackupAgeMs <= BACKUP_OK_MS
            ? w.dataBackupOk
            : w.dataBackupOld(spanText(data.lastBackupAgeMs)),
        ]),
  ];
  lines.push(w.reportData(items.join('. ')));

  return systemMessage('MONTHLY_REPORT', lines, {
    title: `MONTHLY REPORT ${month} ${String(parts.year)}`,
    body: `${String(summary.resolvedValid)} valid results, net ${signedRText(summary.netR)}.`,
    urgency: 'normal',
    url: '/analytics',
  });
}
