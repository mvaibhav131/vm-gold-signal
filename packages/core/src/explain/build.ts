import type { FlagResult } from '../gates/flags';
import { QUALITY_GROUPS, type NewsFeedState, type NewsState, type Side } from '../domain';
import type { QualityInputs } from '../scoring/groups';
import type { QualityResult } from '../scoring/score';
import { TRADED_SYMBOL } from '../symbol';
import type { TradePlan } from '../trade/types';
import { groupFacts, type MarketNumbers } from './facts';
import { STRATEGY_NAMES } from './names';
import { setupFacts, type SetupSource } from './setupFacts';
import type {
  ExplanationDoc,
  ExplanationEvidence,
  ExplanationFact,
  ExplanationGroup,
  ExplanationHeadline,
} from './types';
import { weakItems } from './weak';
import { warningsOf, type WarningContext } from './warnings';

export interface ExplanationInput {
  readonly side: Side;
  readonly strategyVersion: string;
  /** The strategy that made the setup, with its own facts. */
  readonly setup: SetupSource;
  /** The levels of the signal (`planTrade`). */
  readonly plan: Pick<
    TradePlan,
    'entry' | 'maxValidEntry' | 'stopLoss' | 'tp1' | 'tp2' | 'riskDistance'
  >;
  /** The quality score; it must have a score and a grade (a setup below 65 never becomes a signal). */
  readonly quality: QualityResult;
  /** The facts that were scored (`qualityStrengths`), shown as the "why". */
  readonly inputs: QualityInputs;
  readonly market: MarketNumbers;
  /** Cross-asset readings that are shown but never used by the score. */
  readonly researchOnly?: readonly ExplanationFact[];
  /** The calendar: its state and the next high-impact event (epoch milliseconds). */
  readonly macro: {
    readonly state: NewsState;
    readonly next: { readonly name: string; readonly at: number } | null;
  };
  /** The headlines of the last 60 minutes, frozen at signal time (at most 3). */
  readonly news: {
    readonly feed: NewsFeedState;
    readonly headlines: readonly ExplanationHeadline[];
  };
  /** The advisory flags that are on: the ones that stayed warnings. */
  readonly flags: readonly FlagResult[];
  readonly warningContext?: WarningContext;
  /** The other open signals at this moment and their total risk in R. */
  readonly open: { readonly count: number; readonly riskR: number };
  readonly evidence: ExplanationEvidence;
}

/**
 * The explanation that is stored with a signal (02_Signal_Engine section 14): a pure function of the
 * facts of the setup, with no language model and no clock. The dashboard shows it as it is and the
 * messages render it in a language.
 *
 * Each group shows the facts that were scored plus the lines of the strategy's own rules (structure
 * and trigger); the weak list names the components of the score that are below the "OK" line.
 */
export function buildExplanation(input: ExplanationInput): ExplanationDoc {
  const { quality, plan } = input;
  if (quality.score === null || quality.grade === null) {
    throw new RangeError('a signal needs a quality score with a grade');
  }
  const extra = setupFacts(input.setup);
  const groups = QUALITY_GROUPS.map((key): ExplanationGroup => {
    const scored = quality.groups.find((group) => group.key === key);
    if (scored === undefined) throw new RangeError(`the quality result has no group ${key}`);
    const lines = key === 'structure' ? extra.structure : key === 'trigger' ? extra.trigger : [];
    return {
      key,
      state: scored.state,
      facts: [...groupFacts(key, input.inputs, input.market), ...lines],
    };
  });
  return {
    headline: `${input.side} ${TRADED_SYMBOL} - ${STRATEGY_NAMES[input.setup.strategyKey]} v${input.strategyVersion}`,
    quality: { score: quality.score, grade: quality.grade },
    levels: {
      entry: plan.entry,
      maxValidEntry: plan.maxValidEntry,
      stop: plan.stopLoss,
      tp1: plan.tp1,
      tp2: plan.tp2,
      riskUsd: plan.riskDistance,
    },
    groups,
    weak: weakItems(input.side, input.inputs),
    researchOnly: [...(input.researchOnly ?? [])],
    macro: {
      state: input.macro.state,
      next:
        input.macro.next === null
          ? null
          : { name: input.macro.next.name, at: new Date(input.macro.next.at).toISOString() },
    },
    news: { feed: input.news.feed, headlines: [...input.news.headlines] },
    warnings: warningsOf(input.flags, input.warningContext),
    open: { count: input.open.count, riskR: input.open.riskR },
    evidence: input.evidence,
  };
}
