import { buildExplanation } from '../explain/build';
import { SELL_INPUTS, explanationInputOf } from '../explain/test-data';
import type { ExplanationDoc } from '../explain/types';
import { DECIDED_AT, planOf } from '../trade/test-data';
import type { TradeOutcome } from '../trade/types';
import type { NewSignalData, ReviewData, SignalRef } from './types';

export const SIGNAL_ID = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';

const plan = planOf();

/** The BUY of the example (S-0042, strategy A): decided at 06:05 UTC, which is 11:35 IST. */
export const BUY_SIGNAL: SignalRef = {
  id: SIGNAL_ID,
  seq: 42,
  side: 'BUY',
  strategyKey: 'trend_pullback',
  strategyVersion: '0.1.0',
  mode: 'LIVE',
  strategyStatus: 'FORWARD_TESTING',
  exitProfile: 'EP1_PARTIAL',
  generatedAt: DECIDED_AT,
  entryValidUntil: plan.entryValidUntil,
  timeStopAt: plan.timeStopAt,
  entry: plan.entry,
  maxValidEntry: plan.maxValidEntry,
  stopLoss: plan.stopLoss,
  tp1: plan.tp1,
  tp2: plan.tp2,
  riskDistance: plan.riskDistance,
};

/** The same trade seen as a SELL: the levels turned around the entry. */
export const SELL_SIGNAL: SignalRef = {
  ...BUY_SIGNAL,
  id: '5c1d7e2a-3f4b-4a6c-8d9e-0a1b2c3d4e5f',
  seq: 43,
  side: 'SELL',
  entry: 3982.63,
  maxValidEntry: 3981.985,
  stopLoss: 4000,
  tp1: 3965.26,
  tp2: 3947.89,
  riskDistance: 17.37,
};

export const EXPLANATION: ExplanationDoc = buildExplanation(explanationInputOf());

export const SELL_EXPLANATION: ExplanationDoc = buildExplanation(
  explanationInputOf({
    side: 'SELL',
    inputs: SELL_INPUTS,
    plan: {
      entry: SELL_SIGNAL.entry,
      maxValidEntry: SELL_SIGNAL.maxValidEntry,
      stopLoss: SELL_SIGNAL.stopLoss,
      tp1: SELL_SIGNAL.tp1,
      tp2: SELL_SIGNAL.tp2,
      riskDistance: SELL_SIGNAL.riskDistance,
    },
  }),
);

export const newSignal = (
  signal: SignalRef = BUY_SIGNAL,
  explanation: ExplanationDoc = signal.side === 'BUY' ? EXPLANATION : SELL_EXPLANATION,
): NewSignalData => ({ signal, explanation });

export const MINUTE = 60_000;

const base: Omit<
  TradeOutcome,
  | 'result'
  | 'closedAt'
  | 'exitPrice'
  | 'exitReason'
  | 'realizedRGross'
  | 'realizedRNet'
  | 'durationS'
  | 'isWin'
> = {
  countsInStats: true,
  costR: 0.04,
  mfeR: 0.2,
  maeR: -1,
  tp1Hit: false,
  tp2Hit: false,
  ambiguous: false,
};

const outcome = (
  minutes: number,
  change: Partial<TradeOutcome> & Pick<TradeOutcome, 'result' | 'exitReason'>,
): TradeOutcome => ({
  ...base,
  closedAt: DECIDED_AT + minutes * MINUTE,
  exitPrice: null,
  realizedRGross: null,
  realizedRNet: null,
  durationS: minutes * 60,
  isWin: false,
  ...change,
});

export const WIN_TP2 = outcome(37, {
  result: 'WIN',
  exitReason: 'TP2',
  exitPrice: 4030.31,
  realizedRGross: 1.5,
  costR: 0.03,
  realizedRNet: 1.47,
  mfeR: 2.1,
  maeR: -0.4,
  tp1Hit: true,
  tp2Hit: true,
  isWin: true,
});

export const WIN_TARGET = outcome(25, {
  result: 'WIN',
  exitReason: 'TARGET',
  exitPrice: 4027.075,
  realizedRGross: 1.5,
  costR: 0,
  realizedRNet: 1.5,
  mfeR: 1.6,
  maeR: -0.1,
  tp1Hit: true,
  isWin: true,
});

export const PARTIAL = outcome(30, {
  result: 'PARTIAL_WIN',
  exitReason: 'STOP_AT_ENTRY',
  exitPrice: 4017.37,
  realizedRGross: 0.5,
  realizedRNet: 0.46,
  mfeR: 1.2,
  maeR: 0,
  tp1Hit: true,
  isWin: true,
});

export const PARTIAL_NO_WIN = { ...PARTIAL, costR: 0.5, realizedRNet: 0, isWin: false };

export const LOSS = outcome(15, {
  result: 'LOSS',
  exitReason: 'STOP',
  exitPrice: 4010.9,
  realizedRGross: -1,
  realizedRNet: -1.04,
  mfeR: 0.2,
  maeR: -1,
});

export const TIME_EXIT = outcome(120, {
  result: 'TIME_EXIT',
  exitReason: 'TIME_STOP',
  exitPrice: 4015.4,
  realizedRGross: -0.15,
  costR: 0.03,
  realizedRNet: -0.18,
  mfeR: 0.5,
  maeR: -0.6,
});

export const DATA_INVALID = outcome(8, {
  result: 'DATA_INVALID',
  exitReason: 'DATA_GAP',
  countsInStats: false,
  costR: 0,
  mfeR: 0.3,
  maeR: -0.2,
});

export const REVIEW: ReviewData = {
  status: 'PRELIMINARY',
  primaryCause: 'NO_FOLLOW_THROUGH',
  causes: [
    { code: 'NO_FOLLOW_THROUGH', evidence: { maxFavourableR: 0.2 } },
    { code: 'HTF_STRUCTURE_BREAK', evidence: { level: 4012.1, tf: '15m' } },
  ],
  weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
  counterfactual: null,
};

export const FINAL_REVIEW: ReviewData = {
  status: 'FINAL',
  primaryCause: 'STOP_HUNT_REVERSAL',
  causes: [{ code: 'STOP_HUNT_REVERSAL', evidence: {} }],
  weakGroupsAtEntry: [],
  counterfactual: { reachedTp1: true, candlesToTp1: 7 },
};
