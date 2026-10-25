import {
  diffRollups,
  rollupsOfTrades,
  type LedgerTrade,
  type RollupDelta,
  type RollupDifference,
} from '@vmgs/core';

/** What a reconciliation does inside the lock: read what is stored, read the signals, and rewrite rows. */
export interface RollupTx {
  /** The stored rollup rows of the FORWARD scope (the monthly and failure tables have no other). */
  stored(): Promise<RollupDelta>;
  /** Every LIVE signal with its outcome and the primary cause of its review, open ones included. */
  ledger(): Promise<LedgerTrade[]>;
  /** Makes each of the rows what `expected` says: written when there is a row, removed when there is none. */
  replace(differences: readonly RollupDifference[]): Promise<void>;
}

/** The store of the rollups, as far as reconciling them needs it. */
export interface RollupStore {
  /**
   * Runs `work` while no signal can be created or closed (and so no rollup written): what the work reads is
   * one consistent state. A signal that is in the middle of its transaction is either wholly in it or wholly out.
   */
  withLock<T>(work: (tx: RollupTx) => Promise<T>): Promise<T>;
}

export interface ReconcileReport {
  /** The signals the recomputation was made from. */
  readonly signals: number;
  /** The rows the stored tables should have, by table. */
  readonly expectedRows: {
    readonly buckets: number;
    readonly monthly: number;
    readonly groups: number;
    readonly causes: number;
  };
  /** The rows that did not agree (before any repair). Empty when the tables were right. */
  readonly differences: readonly RollupDifference[];
  /** Whether the differing rows were rewritten. */
  readonly repaired: boolean;
}

/**
 * Holds the stored rollups to a full recomputation from the signals (01_HLD section 7: "reconciled nightly"). The
 * rollups are written by the transactions that create and close a signal, so a difference means a bug, a manual edit
 * or a restore; it is reported, and with `repair` (the default) the rows are made what the signals say.
 */
export async function reconcileRollups(
  store: RollupStore,
  options: { readonly repair?: boolean } = {},
): Promise<ReconcileReport> {
  const repair = options.repair ?? true;
  return store.withLock(async (tx) => {
    const ledger = await tx.ledger();
    const expected = rollupsOfTrades(ledger);
    const stored = await tx.stored();
    const differences = diffRollups(stored, expected);
    if (repair && differences.length > 0) await tx.replace(differences);
    return {
      signals: ledger.length,
      expectedRows: {
        buckets: expected.buckets.length,
        monthly: expected.monthly.length,
        groups: expected.groups.length,
        causes: expected.causes.length,
      },
      differences,
      repaired: repair && differences.length > 0,
    };
  });
}
