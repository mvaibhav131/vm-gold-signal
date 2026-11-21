import { EVIDENCE_MIN_SAMPLE } from '../evidence';
import {
  fixedText,
  intervalText,
  percentText,
  plainRText,
  priceText,
  signedPriceText,
  signedRText,
  spanText,
} from '../explain/format';
import { matchLevelText } from '../explain/names';
import type { ExplanationDoc, ExplanationEvidence, ExplanationHeadline } from '../explain/types';
import { TRADED_SYMBOL } from '../symbol';
import { breakEvenWinRate } from '../trade/sizing';
import { oneWinIn } from '../stats/breakEven';
import { tradeStyleOfTimes } from '../trade/style';
import { assertLevels, labelLine, rewardR, signalTag, strategyText } from './common';
import { bold, clean, fold, italic, mono } from './markup';
import { ICON, STATE_ICON, sideIcon } from './style';
import { clockText } from './time';
import { fitMessage, type Rendering } from './text';
import type { DisplayOptions, NewSignalData, TelegramMessage } from './types';
import { WORDS, type Words } from './words';

/** How much of the optional parts of the entry alert a level keeps (see `fitMessage`). */
interface Detail {
  readonly researchOnly: boolean;
  readonly headlines: boolean;
  readonly facts: number;
  readonly weak: number;
  readonly dropped: readonly string[];
}

// Level 0 is everything. A longer text drops research-only lines first, then the headlines and the
// facts after the third of a group, and so on: the levels, the targets, the quality, the state of
// every group, the warnings, the open risk and the evidence are in every level.
const DETAIL: readonly Detail[] = [
  { researchOnly: true, headlines: true, facts: Infinity, weak: Infinity, dropped: [] },
  {
    researchOnly: false,
    headlines: true,
    facts: Infinity,
    weak: Infinity,
    dropped: ['research only'],
  },
  {
    researchOnly: false,
    headlines: false,
    facts: 3,
    weak: 5,
    dropped: ['research only', 'headlines', 'facts beyond 3 per group'],
  },
  {
    researchOnly: false,
    headlines: false,
    facts: 1,
    weak: 3,
    dropped: ['research only', 'headlines', 'facts beyond 1 per group', 'weak beyond 3'],
  },
  {
    researchOnly: false,
    headlines: false,
    facts: 0,
    weak: 1,
    dropped: ['research only', 'headlines', 'all facts', 'weak beyond 1'],
  },
];

function levelLines(data: NewSignalData, w: Words, at: (ms: number) => string): string[] {
  const { signal } = data;
  // the price is its own span (not inside bold) so that one tap copies it into the platform
  const row = (icon: string, label: string, price: number, rest: string): string =>
    `${icon} ${bold(label)}  ${mono(priceText(price))}  ${rest}`;
  const lines = [
    row(
      ICON.entry,
      w.entry,
      signal.entry,
      `(${w.doNotChase(signal.side, priceText(signal.maxValidEntry))})`,
    ),
    row(ICON.stop, w.stop, signal.stopLoss, `(${signedPriceText(signal.stopLoss - signal.entry)})`),
    row(
      ICON.tp1,
      w.tp1,
      signal.tp1,
      `(${signedPriceText(Math.abs(signal.tp1 - signal.entry))}, ${plainRText(rewardR(signal, signal.tp1))})  ${w.tp1Note[signal.exitProfile]}`,
    ),
  ];
  if (signal.tp2 !== null) {
    lines.push(
      row(
        ICON.tp2,
        w.tp2,
        signal.tp2,
        `(${signedPriceText(Math.abs(signal.tp2 - signal.entry))}, ${plainRText(rewardR(signal, signal.tp2))})  ${w.runner}`,
      ),
    );
  }
  lines.push(
    `${ICON.time} ${w.validFor(spanText(signal.entryValidUntil - signal.generatedAt), at(signal.entryValidUntil))}`,
  );
  return lines;
}

/** One line of the track record for the plain part of the alert; the full figures are folded. It says what the first target needs to break even. */
function trackLine(e: ExplanationEvidence, w: Words, rewardOfTp1: number): string {
  const needed = breakEvenWinRate(rewardOfTp1);
  if (e.sampleLabel === 'INSUFFICIENT' || e.winRate === null || e.ci === null)
    return w.trackNone(e.n, oneWinIn(needed));
  return w.trackShort(
    percentText(e.winRate),
    e.n,
    e.expectancyR === null ? null : signedRText(e.expectancyR),
    percentText(needed),
  );
}

function groupLines(e: ExplanationDoc, w: Words, d: Detail): string[] {
  return e.groups.map((group) => {
    const facts = group.facts
      .slice(0, d.facts)
      .map((fact) => `${fact.label} ${String(fact.value)}`)
      .join('; ');
    const head = `${STATE_ICON[group.state]} ${bold(`${w.groupName[group.key]} ${group.state}`)}`;
    if (group.state === 'NA' && group.facts.length === 0) return `${head}: ${w.noData}`;
    return facts === '' ? head : `${head}: ${facts}`;
  });
}

function macroLine(e: ExplanationDoc, w: Words, at: (ms: number) => string, now: number): string {
  const state = `${ICON.macro} ${bold(w.macro)}: ${w.macroState[e.macro.state]}.`;
  const { next } = e.macro;
  if (next !== null) {
    const time = Date.parse(next.at);
    return `${state} ${w.nextEvent(clean(next.name), at(time), spanText(Math.max(0, time - now)))}`;
  }
  return e.macro.state === 'CLEAR' ? `${state} ${w.noNextEvent}` : state;
}

function headlineLine(headline: ExplanationHeadline, at: (ms: number) => string): string {
  const impact = headline.impact ?? 'unclassified';
  const sources = clean(headline.sources.join(', '));
  const published =
    headline.publishedAt === null ? '' : `, ${at(Date.parse(headline.publishedAt))}`;
  return `- [${impact}] ${clean(headline.title)} (${sources}${published})`;
}

function newsLines(e: ExplanationDoc, w: Words, d: Detail, at: (ms: number) => string): string[] {
  const title = `${ICON.news} ${bold(w.newsTitle)}`;
  if (e.news.feed === 'UNAVAILABLE') return [`${title}: ${w.newsUnavailable}`];
  const { headlines } = e.news;
  if (headlines.length === 0) return [`${title}: ${w.newsNone}`];
  if (!d.headlines) return [`${title}: ${w.newsCount(headlines.length)}`];
  return [`${title}:`, ...headlines.map((headline) => headlineLine(headline, at)), w.newsContext];
}

function evidenceLines(e: ExplanationEvidence, w: Words): string[] {
  const lines = [`${ICON.evidence} ${bold(w.evidenceTitle)}`];
  if (e.sampleLabel === 'INSUFFICIENT' || e.winRate === null || e.ci === null) {
    lines.push(w.insufficient(e.n, e.wins, EVIDENCE_MIN_SAMPLE));
  } else {
    const figures = [w.winRate(percentText(e.winRate), e.n, intervalText(e.ci))];
    if (e.expectancyR !== null) figures.push(`${w.expectancy} ${signedRText(e.expectancyR)}`);
    if (e.profitFactor !== null) figures.push(`${w.profitFactor} ${fixedText(e.profitFactor, 2)}`);
    lines.push(figures.join('  '));
    const rates = [
      e.tp1Rate === null ? null : w.tp1Reached(percentText(e.tp1Rate)),
      e.tp2Rate === null ? null : w.tp2Reached(percentText(e.tp2Rate)),
    ].filter((text): text is string => text !== null);
    if (rates.length > 0) lines.push(`${rates.join(', ')}.`);
  }
  const source = w.source(w.scope[e.scope], matchLevelText(e.level));
  lines.push(e.sampleLabel === 'LOW_SAMPLE' ? `${source} ${w.lowSample}` : source);
  return lines;
}

function render(data: NewSignalData, options: DisplayOptions, level: number): Rendering {
  const detail = DETAIL[level];
  if (detail === undefined) throw new RangeError(`no detail level ${String(level)}`);
  const { signal, explanation: e } = data;
  const w = WORDS[options.locale];
  const at = (ms: number): string => clockText(ms, options.displayTz, signal.generatedAt);

  // What the owner needs to act on is in plain view and short: the levels, how long the trade may take,
  // the warnings that exist and one line of track record. Everything that explains it is folded.
  const warnings =
    e.warnings.length === 0
      ? [`${ICON.warning} ${bold(w.warnings)}: ${w.none}`]
      : [
          `${ICON.warning} ${bold(w.warnings)}:`,
          ...e.warnings.map((warning) => `- ${warning.text}`),
        ];
  const why = [
    bold(w.whyHeader),
    ...groupLines(e, w, detail),
    `${ICON.weak} ${bold(w.weak)}: ${e.weak.length === 0 ? w.none : e.weak.slice(0, detail.weak).join('; ')}`,
  ];
  if (detail.researchOnly && e.researchOnly.length > 0) {
    why.push(
      `${ICON.research} ${bold(w.researchOnly)}: ${e.researchOnly.map((fact) => `${fact.label} ${String(fact.value)}`).join('; ')}`,
    );
  }
  const holdMs = Math.max(0, signal.timeStopAt - signal.generatedAt);
  const style = tradeStyleOfTimes(signal.generatedAt, signal.timeStopAt);
  const details = [
    bold(w.detailsHeader),
    ...warnings,
    macroLine(e, w, at, signal.generatedAt),
    ...newsLines(e, w, detail, at),
    `${ICON.open} ${bold(w.openSignals)}: ${e.open.count === 0 ? w.none : String(e.open.count)} (${w.openRisk(plainRText(e.open.riskR))})`,
    '',
    ...evidenceLines(e.evidence, w),
    '',
    ...why,
  ];

  const lines: string[] = [
    labelLine(signal, w, true),
    `${sideIcon(signal.side)} ${bold(`${signal.side} ${TRADED_SYMBOL}`)}  ${signalTag(signal.seq)}`,
    italic(strategyText(signal)),
    `${ICON.style} ${bold(w.style[style])}: ${w.styleLine(w.styleHint[style], spanText(holdMs), at(signal.timeStopAt))}`,
    `${ICON.quality} ${bold(w.quality(String(Math.round(e.quality.score)), w.grade[e.quality.grade]))}`,
    '',
    ...levelLines(data, w, at),
    ...(e.warnings.length === 0 ? [] : ['', ...warnings]),
    '',
    `${ICON.evidence} ${trackLine(e.evidence, w, rewardR(signal, signal.tp1))}`,
    italic(`${w.disclaimer} ${w.oneR(priceText(signal.riskDistance))}`),
    '',
    fold(details.join('\n')),
  ];
  return { lines, dropped: detail.dropped };
}

/** How many levels of detail the entry alert has: 0 is everything, the last one the least. */
export const SIGNAL_NEW_LEVELS = DETAIL.length;

/** The entry alert at one level of detail, as lines (what `renderSignalNew` chooses from). */
export function signalNewLines(
  data: NewSignalData,
  options: DisplayOptions,
  level: number,
): Rendering {
  assertLevels(data.signal, data.explanation.levels);
  return render(data, options, level);
}

/**
 * The entry alert (02_Signal_Engine section 14, SIGNAL_NEW): the levels, the validity, the quality,
 * the "why" with the real numbers, the weak points, the warnings, the open risk and the historical
 * evidence, with the label of a paper or replay signal in the first line. The same stored
 * explanation gives the same text in both languages: only the labels differ.
 */
export function renderSignalNew(data: NewSignalData, options: DisplayOptions): TelegramMessage {
  assertLevels(data.signal, data.explanation.levels);
  return fitMessage('SIGNAL_NEW', (level) => render(data, options, level), DETAIL.length - 1);
}
