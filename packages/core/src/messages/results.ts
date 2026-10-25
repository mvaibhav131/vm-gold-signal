import { CAUSE_CATEGORY_OF } from '../domain';
import { priceText, signedRText, spanText } from '../explain/format';
import { EXIT_PROFILE_RULES } from '../trade/types';
import { causeText, evidenceText, labelLine, rewardR, signalTag } from './common';
import { clockText } from './time';
import { fitMessage } from './text';
import type {
  CancelledData,
  ClosedData,
  DisplayOptions,
  FinalReviewData,
  ReviewData,
  SignalRef,
  TelegramMessage,
  Tp1Data,
} from './types';
import { WORDS, type Words } from './words';

const single = (
  kind: Parameters<typeof fitMessage>[0],
  lines: readonly string[],
): TelegramMessage => fitMessage(kind, () => ({ lines, dropped: [] }), 0);

const atFor =
  (signal: SignalRef, options: DisplayOptions) =>
  (ms: number): string =>
    clockText(ms, options.displayTz, signal.generatedAt);

/**
 * SIGNAL_TP1: half of an `EP1_PARTIAL` trade closes at TP1 and the stop moves to the entry. The
 * other profiles have no such step (their target is the end of the trade: SIGNAL_CLOSED).
 */
export function renderSignalTp1(data: Tp1Data, options: DisplayOptions): TelegramMessage {
  const { signal } = data;
  if (signal.exitProfile !== 'EP1_PARTIAL' || signal.tp2 === null) {
    throw new RangeError('only an EP1_PARTIAL trade has a TP1 step');
  }
  const w = WORDS[options.locale];
  const at = atFor(signal, options);
  const share = EXIT_PROFILE_RULES.EP1_PARTIAL.partialShare;
  return single('SIGNAL_TP1', [
    labelLine(signal, w, false),
    w.tp1HitTitle(
      signalTag(signal.seq),
      signedRText(rewardR(signal, signal.tp1)),
      `${String(Math.round(share * 100))}%`,
    ),
    w.priceAt(priceText(data.price), at(data.at), spanText(data.at - signal.generatedAt)),
    w.tp1Action(priceText(signal.entry)),
    w.runnerLine(priceText(signal.tp2), at(signal.timeStopAt)),
  ]);
}

/** The block that explains a loss (02_Signal_Engine section 14, "WHY IT FAILED"). */
function reviewLines(review: ReviewData, w: Words, signal: SignalRef): string[] {
  const line = (label: string, code: ReviewData['primaryCause'], numbers: string): string =>
    `${label}: ${causeText(code, w)}${numbers === '' ? '' : ` - ${numbers}`}`;
  const lines = [w.reviewTitle(review.status)];
  const primary = review.causes.find((cause) => cause.code === review.primaryCause);
  lines.push(line(w.primary, review.primaryCause, primary ? evidenceText(primary.evidence) : ''));
  lines.push(`${w.meaning}: ${w.causeRule[review.primaryCause]}`);
  for (const cause of review.causes) {
    if (cause.code !== review.primaryCause) {
      lines.push(line(w.also, cause.code, evidenceText(cause.evidence)));
    }
  }
  if (review.weakGroupsAtEntry.length > 0) {
    lines.push(
      `${w.weakAtEntry}: ${review.weakGroupsAtEntry.map((entry) => `${w.groupName[entry.group]} (${entry.state})`).join(', ')}`,
    );
  }
  const counterfactual = review.counterfactual;
  if (review.status === 'FINAL' && counterfactual !== null) {
    lines.push(
      counterfactual.reachedTp1 && counterfactual.candlesToTp1 !== null
        ? w.reachedTp1(priceText(signal.tp1), counterfactual.candlesToTp1)
        : w.notReachedTp1,
    );
  }
  if (review.status === 'PRELIMINARY') lines.push(w.finalComing);
  lines.push(w.heuristic);
  return lines;
}

/** One line for a trade that is not a loss: the primary cause of its review, when there is one. */
function causeLine(review: ReviewData | null, w: Words): string[] {
  if (review === null) return [];
  const primary = review.causes.find((cause) => cause.code === review.primaryCause);
  const numbers = primary ? evidenceText(primary.evidence) : '';
  return [
    `${w.cause}: ${causeText(review.primaryCause, w)}${numbers === '' ? '' : `, ${numbers}`}.`,
  ];
}

/**
 * SIGNAL_CLOSED: how a trade ended, in net R after costs: a win, a partial win, a loss, a time
 * exit, or a trade that cannot be trusted because the feed had a gap (`DATA_INVALID`, not counted).
 */
export function renderSignalClosed(data: ClosedData, options: DisplayOptions): TelegramMessage {
  const { signal, outcome, review } = data;
  const w = WORDS[options.locale];
  const at = atFor(signal, options);
  const tag = signalTag(signal.seq);
  const lines = [labelLine(signal, w, false)];

  if (outcome.result === 'CANCELLED') {
    throw new RangeError('a cancelled signal has its own message (renderSignalCancelled)');
  }
  if (outcome.result === 'DATA_INVALID') {
    lines.push(w.dataInvalidTitle(tag), w.dataInvalidBody);
    return single('SIGNAL_CLOSED', lines);
  }
  if (outcome.realizedRNet === null || outcome.exitPrice === null) {
    throw new RangeError(`a ${outcome.result} outcome needs its net R and its exit price`);
  }

  const net = `${signedRText(outcome.realizedRNet)} ${w.net}`;
  const price = priceText(outcome.exitPrice);
  const span = spanText(outcome.durationS * 1000);
  const closedAt = at(outcome.closedAt);
  const exit = w.exitName[outcome.exitReason](price);

  switch (outcome.result) {
    case 'WIN': {
      lines.push(`WIN ${tag}  ${net}  (${w.closedDetail(exit, closedAt, span)})`);
      lines.push(w.mfeMae(signedRText(outcome.mfeR ?? 0), signedRText(outcome.maeR ?? 0)));
      if (data.worked !== undefined && data.worked.length > 0) {
        lines.push(`${w.worked}: ${data.worked.join('; ')}.`);
      }
      break;
    }
    case 'PARTIAL_WIN': {
      lines.push(
        `PARTIAL WIN ${tag}  ${net}  (${w.closedDetail(w.afterTp1(exit), closedAt, span)})`,
      );
      lines.push(...causeLine(review, w));
      lines.push(
        outcome.isWin
          ? w.partialPaid(
              signedRText(
                EXIT_PROFILE_RULES.EP1_PARTIAL.partialShare * rewardR(signal, signal.tp1),
              ),
            )
          : w.partialNotWin,
      );
      break;
    }
    case 'LOSS': {
      lines.push(`LOSS ${tag}  ${net}  (${w.stoppedDetail(exit, closedAt, span)})`);
      if (review !== null) lines.push(...reviewLines(review, w, signal));
      break;
    }
    case 'TIME_EXIT': {
      lines.push(`TIME EXIT ${tag}  ${net}  (${w.timeExitDetail(span, price)})`);
      lines.push(outcome.tp1Hit ? w.timeExitAfterTp1 : w.timeExitNone);
      lines.push(...causeLine(review, w));
      break;
    }
  }
  return single('SIGNAL_CLOSED', lines);
}

/** SIGNAL_CANCELLED: the data went stale while the entry was still valid, so the trade could not be followed. */
export function renderSignalCancelled(
  data: CancelledData,
  options: DisplayOptions,
): TelegramMessage {
  const { signal } = data;
  const w = WORDS[options.locale];
  return single('SIGNAL_CANCELLED', [
    labelLine(signal, w, false),
    w.cancelledTitle(signalTag(signal.seq)),
    w.cancelledReason(data.staleSeconds, spanText(signal.entryValidUntil - signal.generatedAt)),
    w.manageManually,
  ]);
}

/** SIGNAL_REVIEW_FINAL: the review after the time to see whether price reached TP1 later. */
export function renderFinalReview(data: FinalReviewData, options: DisplayOptions): TelegramMessage {
  const { signal, review } = data;
  const w = WORDS[options.locale];
  const category = w.categoryName[CAUSE_CATEGORY_OF[review.primaryCause]];
  const lines = [
    labelLine(signal, w, false),
    w.finalTitle(signalTag(signal.seq)),
    data.previousPrimary !== null && data.previousPrimary !== review.primaryCause
      ? w.causeUpdated(review.primaryCause, category, data.previousPrimary)
      : w.causeConfirmed(review.primaryCause, category),
  ];
  const counterfactual = review.counterfactual;
  if (counterfactual !== null) {
    lines.push(
      counterfactual.reachedTp1 && counterfactual.candlesToTp1 !== null
        ? w.reachedTp1(priceText(signal.tp1), counterfactual.candlesToTp1)
        : w.notReachedTp1,
    );
  }
  lines.push(`${w.meaning}: ${w.causeRule[review.primaryCause]}`);
  if (data.trackedThisMonth !== null) lines.push(w.tracked(data.trackedThisMonth));
  lines.push(w.heuristic);
  return single('SIGNAL_REVIEW_FINAL', lines);
}
