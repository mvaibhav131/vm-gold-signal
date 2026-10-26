import type { CauseCode, GroupState, QualityGroup, Result, Side } from '@vmgs/core';

import type { TradeRow } from './reader';

export const HOUR = 3_600_000;
/** 2026-10-05 08:00 UTC: the first signal of the fixtures. */
export const START = Date.UTC(2026, 9, 5, 8, 0, 0);

const COUNTED = new Set<Result>(['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT']);

export interface RowSpec {
  readonly seq: number;
  /** The net R of the result. The result follows its sign unless `result` says otherwise. */
  readonly net?: number;
  readonly result?: Result;
  /** A signal that has no outcome yet. */
  readonly open?: boolean;
  readonly counts?: boolean;
  readonly generatedAt?: number;
  readonly closedAt?: number;
  readonly durationS?: number;
  readonly tp1?: boolean;
  readonly tp2?: boolean;
  readonly strategy?: string;
  readonly side?: Side;
  readonly session?: string;
  readonly regime?: string;
  readonly vol?: string;
  readonly news?: string;
  readonly score?: number;
  readonly groups?: readonly (readonly [QualityGroup, GroupState])[];
  readonly cause?: CauseCode;
  readonly weak?: readonly QualityGroup[];
}

/** A signal of the fixtures: a winner of 1 R of trend pullback, a BUY in London, an hour after the one before. */
export function row(spec: RowSpec): TradeRow {
  const generatedAt = spec.generatedAt ?? START + spec.seq * HOUR;
  const net = spec.net ?? 1;
  const result: Result = spec.result ?? (net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'PARTIAL_WIN');
  const counts = spec.counts ?? COUNTED.has(result);
  return {
    seq: spec.seq,
    generatedAt,
    strategyKey: spec.strategy ?? 'trend_pullback',
    side: spec.side ?? 'BUY',
    session: spec.session ?? 'LONDON',
    regime: spec.regime ?? 'TREND_UP',
    volBucket: spec.vol ?? 'NORMAL',
    newsState: spec.news ?? 'CLEAR',
    qualityScore: spec.score ?? 78,
    groups: (spec.groups ?? []).map(([key, state]) => ({ key, state })),
    outcome:
      spec.open === true
        ? null
        : {
            result,
            countsInStats: counts,
            realizedRNet: counts ? net : null,
            durationS: spec.durationS ?? 1800,
            tp1Hit: spec.tp1 ?? false,
            tp2Hit: spec.tp2 ?? false,
            closedAt: spec.closedAt ?? generatedAt + 1_800_000,
          },
    primaryCause: spec.cause ?? null,
    weakGroups: spec.weak ?? [],
  };
}

/** `count` signals of one strategy, the first `wins` of them winners, closing one after the other. */
export function series(
  strategy: string,
  count: number,
  wins: number,
  firstSeq: number,
  generatedFrom = START,
): TradeRow[] {
  return Array.from({ length: count }, (_unused, index) =>
    row({
      seq: firstSeq + index,
      strategy,
      net: index < wins ? 1.5 : -1,
      generatedAt: generatedFrom + index * HOUR,
    }),
  );
}
