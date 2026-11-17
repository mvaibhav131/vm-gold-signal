import type {
  Regime,
  Session,
  Side,
  StrategyKey,
  StrategyStatus,
  Timeframe,
  VolBucket,
} from '../domain';
import type { ExplanationEvidence, ExplanationHeadline } from '../explain/types';
import type { AdvisoryModes, FlagResult } from '../gates/flags';
import type { FeedFacts, GateParams, GateResult } from '../gates/types';
import type { MacroEventInput, NewsWindowSpec } from '../context/macro';
import type { QualityWeights } from '../scoring/score';
import type { BucketDims } from '../stats/evidence';
import type { PatternBreakoutParams } from '../strategies/patternBreakout/types';
import type { HourlyTrendParams } from '../strategies/hourlyTrend/types';
import type { SqueezeRetestParams } from '../strategies/squeezeRetest/types';
import type { SweepReversalParams } from '../strategies/sweepReversal/types';
import type { TrendPullbackParams } from '../strategies/trendPullback/types';
import type { TrendlineRetestParams } from '../strategies/trendlineRetest/types';
import type { StrategySetup } from '../strategies/types';
import type { StructureCandle } from '../structure/types';
import type { QuoteTick, RiskParams, TradePlan } from '../trade/types';
import type { SetupSource } from '../explain/setupFacts';

/** The three timeframes of the engine: the 5m trigger, the 15m context and the 1h bias (docs/02 section 2). */
export const ENGINE_TIMEFRAMES = ['5m', '15m', '1h'] as const satisfies readonly Timeframe[];
export type EngineTimeframe = (typeof ENGINE_TIMEFRAMES)[number];

/** A closed candle of mid prices, with the average spread of its ticks (null when it had none). */
export interface EngineCandle extends StructureCandle {
  readonly spread: number | null;
}

/** What the engine needs to know about one strategy version: the numbers of its config, in the shapes the code reads. */
interface SpecBase {
  readonly version: string;
  readonly status: StrategyStatus;
  readonly acceptedRegimes: readonly Regime[];
  readonly gates: GateParams;
  readonly requiredTimeframes: readonly Timeframe[];
  /** The advisory modes of the strategy config; the owner's settings override them per decision. */
  readonly modes: AdvisoryModes;
  readonly risk: RiskParams;
  readonly weights: QualityWeights;
  readonly newsWindow: NewsWindowSpec;
}

export type StrategySpec = SpecBase &
  (
    | { readonly strategyKey: 'trend_pullback'; readonly params: TrendPullbackParams }
    | { readonly strategyKey: 'sweep_reversal'; readonly params: SweepReversalParams }
    | { readonly strategyKey: 'squeeze_retest'; readonly params: SqueezeRetestParams }
    | { readonly strategyKey: 'trendline_retest'; readonly params: TrendlineRetestParams }
    | { readonly strategyKey: 'pattern_breakout'; readonly params: PatternBreakoutParams }
    | { readonly strategyKey: 'hourly_trend'; readonly params: HourlyTrendParams }
  );

/** A setup that a strategy found on the newest 5m candle, with the context the statistics key needs. */
export interface Candidate {
  readonly spec: StrategySpec;
  readonly setup: StrategySetup;
  /** The facts of the setup, with the strategy they belong to (the explanation reads them). */
  readonly source: SetupSource;
  /** The key of the evidence of this kind of setup (`bucketKeys`). */
  readonly dims: BucketDims;
  /** The liquidity level that the setup sweeps: it is the reason for the trade, not an obstacle (NEAR_LEVEL). */
  readonly sweptLevelId: string | null;
  /** The price that EP3 aims at and strategy E measures its move to; null when the strategy has none. */
  readonly structureTarget: number | null;
}

export interface OpenSignalInput {
  readonly id: string;
  readonly side: Side;
  /** What the signal still risks, in R (1 before TP1, 0 once the stop is at the entry). */
  readonly riskR: number;
}

export type SignalDraftMode = 'LIVE' | 'SIMULATED' | 'BACKTEST';

/** What is known when the first quote of the new candle arrives. Everything outside the candles comes from here. */
export interface DecisionContext {
  readonly mode: SignalDraftMode;
  /** The first quote at or after the close of the 5m candle (the confirming tick). */
  readonly quote: QuoteTick;
  readonly feed: FeedFacts;
  /** Median of receive time minus source time; null while unknown. */
  readonly clockSkewMs: number | null;
  /** The receive time of the quote minus its source time, null when not known. */
  readonly dataLatencyMs: number | null;
  /** The calendar: null events and `available: false` when the feed is down (the news state is then UNKNOWN). */
  readonly calendar: {
    readonly available: boolean;
    readonly events: readonly MacroEventInput[];
    /** Names of the events by id, for the lines of the explanation. */
    readonly names?: Readonly<Record<string, string>>;
  };
  readonly news: {
    readonly feed: 'AVAILABLE' | 'UNAVAILABLE';
    readonly headlines: readonly ExplanationHeadline[];
    /** When the newest HIGH-impact headline cluster was published. */
    readonly lastHighHeadlineAt: number | null;
  };
  readonly open: readonly OpenSignalInput[];
  /** The owner's switches over the strategy config's modes. */
  readonly modes?: Partial<AdvisoryModes>;
  /** Names of open signals for the warning lines (`#S-0042`), by id. */
  readonly openLabels?: Readonly<Record<string, string>>;
}

/** A setup that passed every gate: the signal as the worker hands it to the signal transaction (the `signalDraftSchema` shape). */
export interface EngineSignalDraft {
  readonly symbol: string;
  readonly side: Side;
  readonly strategyKey: StrategyKey;
  readonly strategyVersion: string;
  readonly exitProfile: string;
  readonly mode: SignalDraftMode;
  readonly generatedAt: string;
  readonly sourceAt: string;
  readonly entry: number;
  readonly maxValidEntry: number;
  readonly entryValidUntil: string;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly riskDistance: number;
  readonly atr5: number;
  readonly timeStopAt: string;
  readonly regime: Regime;
  readonly session: Session;
  readonly volBucket: VolBucket;
  readonly newsState: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN';
  readonly setupKey: string;
  readonly openSignalsAtEntry: number;
  readonly warnings: readonly string[];
  readonly chartObjects: readonly EngineChartObject[];
  readonly qualityScore: number;
  readonly groupedScores: readonly { key: string; state: string; strength: number | null }[];
  readonly hardGates: readonly { code: string; passed: boolean; value?: number; limit?: number }[];
  readonly explanation: unknown;
  readonly evidence: ExplanationEvidence;
  readonly dataLatencyMs: number | null;
  readonly featureSnapshot: Readonly<Record<string, unknown>>;
}

export interface EngineChartObject {
  readonly id: string;
  readonly type: 'trendline' | 'channel' | 'zone' | 'pattern' | 'fib';
  readonly tf: Timeframe;
  readonly points: readonly { readonly t: string; readonly price: number }[];
  readonly meta: Readonly<Record<string, unknown>>;
}

/** A setup that satisfied the rules of its strategy but may not become a signal (`rejections`, "WAIT: reason"). */
export interface Rejection {
  readonly strategyKey: StrategyKey;
  readonly side: Side;
  readonly setupKey: string;
  /** The failed gates, then the advisory flags that the owner switched to block. */
  readonly codes: readonly string[];
  readonly qualityScore: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type Outcome =
  | {
      readonly kind: 'SIGNAL';
      readonly candidate: Candidate;
      readonly draft: EngineSignalDraft;
      /** The trade as planned at the confirming quote (the levels of the draft, with what the fill model needs). */
      readonly plan: TradePlan;
    }
  | { readonly kind: 'REJECTED'; readonly candidate: Candidate; readonly rejection: Rejection };

/** The market's own state at the decision, with or without a setup (the engine snapshot of the dashboard and `/status`). */
export interface DecisionReport {
  /** Open time of the 5m candle that closed. */
  readonly openTime: number;
  readonly decidedAt: number;
  readonly regime: Regime | null;
  readonly volBucket: VolBucket | null;
  readonly session: Session;
  readonly newsState: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN';
  readonly atr5: number | null;
  readonly counts: Readonly<Record<EngineTimeframe, number>>;
  /** The five gates that do not depend on a setup, as they stood. A failed one is why nothing can be sent now. */
  readonly marketGates: readonly GateResult[];
  readonly candidates: number;
}

export interface EngineDecision {
  readonly report: DecisionReport;
  readonly outcomes: readonly Outcome[];
}

export type { FlagResult };
