import type { SignalDraft } from '@vmgs/contracts';
import type { RollupSignal } from '@vmgs/core';

import type { StrategyVersionRef } from '../lifecycle/types';

/** The keys a new signal is filed under in the rollups, from its draft and the strategy version it belongs to. */
export function rollupSignalOf(draft: SignalDraft, strategy: StrategyVersionRef): RollupSignal {
  return {
    strategyKey: strategy.strategyKey,
    version: strategy.version,
    side: draft.side,
    session: draft.session,
    regime: draft.regime,
    volBucket: draft.volBucket,
    generatedAt: Date.parse(draft.generatedAt),
    groups: draft.groupedScores.map(({ key, state }) => ({ key, state })),
  };
}
