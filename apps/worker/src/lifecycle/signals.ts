import type { StrategyConfig } from '@vmgs/config';
import { signalDraftSchema, type SignalDraft } from '@vmgs/contracts';
import { displayOptionsOf, newSignalChannels, signalOutboxRows, type SignalRef } from '@vmgs/core';

import type {
  CreateSignalResult,
  CreatedSignal,
  LifecycleStore,
  StrategyVersionRef,
} from './types';

export interface SignalCreatorOptions {
  readonly store: LifecycleStore;
  readonly now?: () => number;
  /** Called after the signal transaction committed, with the id: the outcome tracker starts following it. */
  readonly onCreated?: (signalId: string) => Promise<void>;
}

const versionKey = (strategyKey: string, version: string): string => `${strategyKey}@${version}`;

/** The reference every message about a signal carries, from a draft that has just been given its number. */
function signalRefOfDraft(
  created: CreatedSignal,
  strategy: StrategyVersionRef,
  draft: SignalDraft,
): SignalRef {
  return {
    id: created.id,
    seq: created.seq,
    side: draft.side,
    strategyKey: strategy.strategyKey,
    strategyVersion: strategy.version,
    mode: draft.mode,
    strategyStatus: strategy.status,
    exitProfile: draft.exitProfile,
    generatedAt: Date.parse(draft.generatedAt),
    entryValidUntil: Date.parse(draft.entryValidUntil),
    timeStopAt: Date.parse(draft.timeStopAt),
    entry: draft.entry,
    maxValidEntry: draft.maxValidEntry,
    stopLoss: draft.stopLoss,
    tp1: draft.tp1,
    tp2: draft.tp2,
    riskDistance: draft.riskDistance,
  };
}

/**
 * The signal transaction (01_HLD section 5, step 4): checks a signal the engine has decided on,
 * finds out who is to be told, and has the store write the signal, its state, its first event and
 * the entry alerts in one transaction. It writes nothing for a setup that already has a signal.
 */
export class SignalCreator {
  private readonly store: LifecycleStore;
  private readonly now: () => number;
  private readonly onCreated: ((signalId: string) => Promise<void>) | undefined;
  private readonly strategies = new Map<string, StrategyVersionRef>();

  constructor(options: SignalCreatorOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.onCreated = options.onCreated;
  }

  /** Makes the strategy versions known (and stored), so that signals can point at them. */
  async registerStrategies(configs: readonly StrategyConfig[]): Promise<void> {
    for (const config of configs) {
      const ref = await this.store.ensureStrategyVersion(config);
      this.strategies.set(versionKey(config.strategyKey, config.version), ref);
    }
  }

  /** `input` is checked against the signal contract; a signal that breaks a rule is refused, never written. */
  async create(input: unknown): Promise<CreateSignalResult> {
    const draft = signalDraftSchema.parse(input);
    const strategy = this.strategies.get(versionKey(draft.strategyKey, draft.strategyVersion));
    if (strategy === undefined) {
      throw new Error(
        `strategy version ${draft.strategyKey}@${draft.strategyVersion} is not registered`,
      );
    }
    const settings = await this.store.loadSettings();
    const channels = newSignalChannels(
      settings,
      draft.strategyKey,
      draft.explanation.quality.grade,
    );
    const now = this.now();
    const result = await this.store.createSignal(
      draft,
      strategy,
      (created) =>
        signalOutboxRows(
          {
            kind: 'SIGNAL_NEW',
            data: {
              signal: signalRefOfDraft(created, strategy, draft),
              explanation: draft.explanation,
            },
          },
          displayOptionsOf(settings),
          channels,
          now,
        ),
      now,
    );
    if (result.status === 'CREATED' && this.onCreated !== undefined) {
      await this.onCreated(result.created.id);
    }
    return result;
  }
}
