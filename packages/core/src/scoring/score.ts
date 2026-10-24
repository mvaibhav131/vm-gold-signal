import {
  QUALITY_GROUPS,
  type Grade,
  type GroupState,
  type QualityGroup,
  type Side,
} from '../domain';
import { groupState, qualityGrade } from '../quality';
import {
  executionStrength,
  rewardStrength,
  sessionMacroStrength,
  structureStrength,
  trendStrength,
  triggerStrength,
  volatilityStrength,
  type QualityInputs,
} from './groups';
import { roundTo } from '../trade/round';

export type QualityStrengths = Readonly<Record<QualityGroup, number | null>>;
export type QualityWeights = Readonly<Record<QualityGroup, number>>;

/** The strength of each group (docs/02 section 8.1), null where the data was not available. */
export function qualityStrengths(side: Side, inputs: QualityInputs): QualityStrengths {
  return {
    trend: trendStrength(side, inputs.trend),
    structure: structureStrength(side, inputs.structure),
    trigger: triggerStrength(side, inputs.trigger),
    volatility: volatilityStrength(inputs.volatility),
    execution: executionStrength(inputs.execution),
    sessionMacro: sessionMacroStrength(inputs.sessionMacro),
    reward: rewardStrength(inputs.reward),
  };
}

export interface QualityGroupScore {
  readonly key: QualityGroup;
  readonly state: GroupState;
  /** 0 to 1 at 4 decimals; null when the data was not available. */
  readonly strength: number | null;
}

export interface QualityResult {
  /** In the order of `QUALITY_GROUPS`; the form stored in `signals.grouped_scores`. */
  readonly groups: readonly QualityGroupScore[];
  /** The share of the total weight that had data, 0 to 1. */
  readonly coverage: number;
  /** 0 to 100 at 2 decimals; null when no group had data. */
  readonly score: number | null;
  /** Null below 65: such a setup cannot become a signal. */
  readonly grade: Grade | null;
}

/**
 * The quality score of docs/02 section 8: the weighted mean of the group strengths, scaled to 0 to
 * 100. A group without data (state `NA`) gives its weight to the others, so the score rests on the
 * groups that exist, and `coverage` says how much of the weight that is (the gate QUALITY_OK needs
 * at least 70 percent). Strengths are rounded to 4 decimals first, so the state of a group always
 * agrees with the strength that is stored.
 */
export function scoreQuality(strengths: QualityStrengths, weights: QualityWeights): QualityResult {
  let total = 0;
  let available = 0;
  let weighted = 0;
  const groups = QUALITY_GROUPS.map((key): QualityGroupScore => {
    const raw = strengths[key];
    if (raw !== null && !(raw >= 0 && raw <= 1)) {
      throw new RangeError(`the strength of ${key} must be between 0 and 1`);
    }
    const weight = weights[key];
    if (!(weight >= 0) || !Number.isFinite(weight))
      throw new RangeError(`the weight of ${key} is not valid`);
    total += weight;
    const strength = raw === null ? null : roundTo(raw, 4);
    if (strength !== null) {
      available += weight;
      weighted += weight * strength;
    }
    return { key, state: groupState(strength), strength };
  });
  if (!(total > 0)) throw new RangeError('the weights must add up to more than zero');
  const score = available > 0 ? roundTo((100 * weighted) / available, 2) : null;
  return {
    groups,
    coverage: available / total,
    score,
    grade: score === null ? null : qualityGrade(score),
  };
}
