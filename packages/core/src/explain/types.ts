import type {
  AdvisoryFlag,
  Grade,
  GroupState,
  NewsFeedState,
  NewsImpact,
  NewsState,
  NewsTopic,
  QualityGroup,
  StatsScope,
} from '../domain';
import type { SampleLabel } from '../evidence';

// The stored explanation (02_Signal_Engine section 14), as the engine builds it. These are the
// same shapes as `explanationSchema` of the contracts package (which cannot be imported here: it
// depends on core); a contract test parses what `buildExplanation` makes, so the two cannot drift.
// Arrays are mutable on purpose, to stay assignable to the types the schema infers.

export interface ExplanationFact {
  readonly label: string;
  readonly value: string | number;
}

export interface ExplanationGroup {
  readonly key: QualityGroup;
  readonly state: GroupState;
  readonly facts: ExplanationFact[];
}

export interface ExplanationHeadline {
  readonly title: string;
  readonly sources: string[];
  /** ISO time, null when the feed gave none. */
  readonly publishedAt: string | null;
  readonly impact: NewsImpact | null;
  readonly topics: NewsTopic[];
  readonly url: string;
  readonly classified: boolean;
}

export interface ExplanationEvidence {
  readonly scope: StatsScope;
  /** 0 is the exact bucket, 4 is strategy and side only. */
  readonly level: number;
  readonly n: number;
  readonly wins: number;
  readonly sampleLabel: SampleLabel;
  readonly winRate: number | null;
  readonly ci: [number, number] | null;
  readonly expectancyR: number | null;
  readonly profitFactor: number | null;
  readonly tp1Rate: number | null;
  readonly tp2Rate: number | null;
}

export interface ExplanationWarning {
  readonly code: AdvisoryFlag;
  readonly text: string;
}

export interface ExplanationDoc {
  readonly headline: string;
  readonly quality: { readonly score: number; readonly grade: Grade };
  readonly levels: {
    readonly entry: number;
    readonly maxValidEntry: number;
    readonly stop: number;
    readonly tp1: number;
    readonly tp2: number | null;
    readonly riskUsd: number;
  };
  readonly groups: ExplanationGroup[];
  readonly weak: string[];
  readonly researchOnly: ExplanationFact[];
  readonly macro: {
    readonly state: NewsState;
    /** `at` is an ISO time. */
    readonly next: { readonly name: string; readonly at: string } | null;
  };
  readonly news: { readonly feed: NewsFeedState; readonly headlines: ExplanationHeadline[] };
  readonly warnings: ExplanationWarning[];
  readonly open: { readonly count: number; readonly riskR: number };
  readonly evidence: ExplanationEvidence;
}
