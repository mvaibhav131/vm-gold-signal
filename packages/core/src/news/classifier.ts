import { NEWS_TOPICS, type NewsImpact, type NewsTopic } from '../domain';
import { STRENGTH_VALUE, TOPIC_RULES, type Keyword } from './rules';

/** The version of the rules. Changing a rule or a number below means a new version and new golden tests. */
export const CLASSIFIER_VERSION = '1.0.0';

/** An item older than this when it is first seen is not kept: it is not news any more. */
export const MAX_ITEM_AGE_MS = 6 * 60 * 60_000;

/** A topic counts when its weight times the strength of its best phrase is at least this. */
export const MIN_TOPIC_SCORE = 0.3;
/** The impact score at which a headline is HIGH and MEDIUM. */
export const IMPACT_HIGH = 0.65;
export const IMPACT_MEDIUM = 0.45;

/** How much an outlet is trusted: 1 official, 2 a major outlet, 3 an aggregator. */
export type SourceTier = 1 | 2 | 3;
export const TIER_FACTOR: Readonly<Record<SourceTier, number>> = { 1: 1, 2: 0.9, 3: 0.7 };

/** A phrase found only in the summary counts a little less than one in the title. */
export const SUMMARY_FACTOR = 0.7;

/** How fresh the headline is when it is read: a day-old story is less likely to move the market now. */
export function recencyFactor(ageMs: number): number {
  if (ageMs <= 60 * 60_000) return 1;
  if (ageMs <= 180 * 60_000) return 0.8;
  return 0.6;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

interface Compiled extends Keyword {
  readonly regex: RegExp;
}

// Word boundaries that also hold for letters outside ASCII.
const compile = (keyword: Keyword): Compiled => ({
  ...keyword,
  regex: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${keyword.pattern})(?![\\p{L}\\p{N}])`,
    keyword.caseSensitive === true ? 'u' : 'iu',
  ),
});

const COMPILED = TOPIC_RULES.map((rule) => ({
  topic: rule.topic,
  weight: rule.weight,
  keywords: rule.keywords.map(compile),
}));

export interface ClassifyInput {
  readonly title: string;
  readonly summary?: string | null;
  readonly tier: SourceTier;
  /** How long ago it was published when it is read; 0 when the feed gave no time. */
  readonly ageMs: number;
}

export interface TopicMatch {
  readonly topic: NewsTopic;
  /** The text that matched. */
  readonly phrase: string;
  /** Weight of the topic times strength of the phrase (times the summary factor), 2 decimals. */
  readonly score: number;
  readonly in: 'title' | 'summary';
}

export interface Classification {
  /** Every topic that counts, the strongest first. */
  readonly topics: NewsTopic[];
  /** The strongest topic. */
  readonly primary: NewsTopic;
  /** Best topic score times the outlet and the freshness, 2 decimals (`news_items.impact_score`). */
  readonly score: number;
  readonly impact: NewsImpact;
  /** The best match of each topic that counts, for the review of a classification. */
  readonly matches: TopicMatch[];
}

export function impactOf(score: number): NewsImpact {
  if (score >= IMPACT_HIGH) return 'HIGH';
  if (score >= IMPACT_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Tags an item by the rules: which topics it is about and how much it may matter. Null when it
 * matches none (sport, entertainment, local news): that is the relevance filter, and the item is
 * then only kept in the short buffer of unclassified headlines. Deterministic: the same item gives
 * the same answer. Never says whether the news is good or bad for gold.
 */
export function classify(input: ClassifyInput): Classification | null {
  const fields = [
    { name: 'title' as const, text: input.title, factor: 1 },
    ...(input.summary === null || input.summary === undefined || input.summary === ''
      ? []
      : [{ name: 'summary' as const, text: input.summary, factor: SUMMARY_FACTOR }]),
  ];

  const found: TopicMatch[] = [];
  for (const rule of COMPILED) {
    let best: TopicMatch | null = null;
    for (const keyword of rule.keywords) {
      for (const field of fields) {
        const hit = keyword.regex.exec(field.text);
        if (hit === null) continue;
        const score = round2(rule.weight * STRENGTH_VALUE[keyword.strength] * field.factor);
        if (best === null || score > best.score) {
          best = { topic: rule.topic, phrase: hit[0], score, in: field.name };
        }
      }
    }
    if (best !== null && best.score >= MIN_TOPIC_SCORE) found.push(best);
  }
  if (found.length === 0) return null;

  found.sort(
    (a, b) => b.score - a.score || NEWS_TOPICS.indexOf(a.topic) - NEWS_TOPICS.indexOf(b.topic),
  );
  const top = found[0];
  if (top === undefined) return null;
  const score = round2(top.score * TIER_FACTOR[input.tier] * recencyFactor(input.ageMs));
  return {
    topics: found.map((match) => match.topic),
    primary: top.topic,
    score,
    impact: impactOf(score),
    matches: found,
  };
}
