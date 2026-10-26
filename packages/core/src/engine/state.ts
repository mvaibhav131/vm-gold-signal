import type { Regime, Session, Timeframe, VolBucket } from '../domain';
import { gateWaitReasons } from '../gates/labels';
import { warmupProgress } from '../gates/blocking';
import type { GateParams } from '../gates/types';
import type { DecisionReport } from './types';

/** The `app_settings` key that holds the engine state after each decision (the worker writes it, the API reads it). */
export const ENGINE_STATE_KEY = 'engineState';

/**
 * What the engine says about itself between decisions: the regime, the session, the news state, how far the warm-up is, and the
 * reasons why a signal could not be sent now. The decision loop stores it after every 5m candle; `/status`, `/open` and the dashboard read it.
 */
export interface EngineStateDoc {
  /** When the decision was made (the close of the 5m candle). */
  readonly evaluatedAt: number;
  readonly regime: Regime | null;
  readonly volBucket: VolBucket | null;
  readonly session: Session;
  readonly newsState: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN';
  readonly atr5: number | null;
  readonly warmup: {
    readonly ready: boolean;
    readonly progressPct: number;
    readonly missingTimeframes: readonly Timeframe[];
  };
  /** One per failed market gate, in the order of the gates (`code` and `label` as the API's wait reasons). */
  readonly waitReasons: readonly { readonly code: string; readonly label: string }[];
}

/** The state of the engine is shown for this long after the decision it comes from (a closed weekend market makes no decision; a dead loop must not show an old regime for days). */
export const ENGINE_STATE_MAX_AGE_MS = 12 * 3_600_000;

/** The engine state of a decision, from its report and the warm-up numbers of the strategies. */
export function engineStateOf(
  report: DecisionReport,
  required: readonly Timeframe[],
  warmupCandles: GateParams['warmupCandles'],
): EngineStateDoc {
  const progress = warmupProgress(report.counts, required, warmupCandles);
  return {
    evaluatedAt: report.decidedAt,
    regime: report.regime,
    volBucket: report.volBucket,
    session: report.session,
    newsState: report.newsState,
    atr5: report.atr5,
    warmup: {
      ready: progress.ready,
      progressPct: progress.progressPct,
      missingTimeframes: progress.missingTimeframes,
    },
    waitReasons: gateWaitReasons(
      report.marketGates,
      report.regime === null ? {} : { regime: report.regime },
    ),
  };
}
