import {
  QUALITY_GROUPS,
  bucketStart,
  type CauseCode,
  type QualityGroup,
  type Result,
  type Side,
  type StrategyKey,
} from '@vmgs/core';
import {
  autopsySchema,
  featureSnapshotResponseSchema,
  outcomeSchema,
  signalDetailSchema,
  signalEventSchema,
  signalHistoryRowSchema,
  type Autopsy,
  type CandlesResponse,
  type Evidence,
  type FeatureSnapshotResponse,
  type Outcome,
  type Signal,
  type SignalDetail,
  type SignalEvent,
  type SignalHistoryRow,
} from '@vmgs/contracts';

import {
  FORWARD_LOW_SAMPLE,
  SQUEEZE_RETEST_FACTS,
  SWEEP_REVERSAL_FACTS,
  TREND_PULLBACK_FACTS,
  UNVALIDATED,
  buildSignalFrom,
  weightedScore,
  type Facts,
  type SignalSpec,
  type Strengths,
} from './signals';
import { hash01, round3 } from './world';

// The simulated history: 41 finished signals over about three months, shaped like the example of the
// monthly report in 04_API_and_Notifications section 4.2 (14 wins, 6 partial wins, 15 losses, 4 time
// exits, 1 cancelled, 1 with invalid data; 21 of the 39 valid results above zero). Everything is a
// pure function of the anchor time, so the preview shows the same signals on every run.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CANDLE_MS = 5 * MINUTE_MS;
/** The detail screen shows 60 candles of 5m before the signal and 60 after the exit. */
export const CHART_CONTEXT_CANDLES = 60;
/** The final review follows the preliminary one 60 minutes later (02_Signal_Engine section 12). */
export const REVIEW_FINAL_AFTER_MS = 60 * MINUTE_MS;
/** The oldest signal's feature snapshot is the one that retention has already removed. */
const PRUNED_SEQ = 1;

type Letter = 'A' | 'B' | 'C';
type PlanRow = readonly [
  strategy: Letter,
  side: Side,
  result: Result,
  cause: CauseCode | null,
  netR: number | null,
  minutes: number,
];

const STRATEGIES: Readonly<Record<Letter, { key: StrategyKey; name: string; facts: Facts }>> = {
  A: { key: 'trend_pullback', name: 'Trend Pullback', facts: TREND_PULLBACK_FACTS },
  B: { key: 'sweep_reversal', name: 'Liquidity Sweep Reversal', facts: SWEEP_REVERSAL_FACTS },
  C: { key: 'squeeze_retest', name: 'Squeeze Breakout and Retest', facts: SQUEEZE_RETEST_FACTS },
};

/** Signal 1 is the oldest. Signals 39 to 41 are the three that the dashboard has always listed as finished. */
const PLAN: readonly PlanRow[] = [
  ['A', 'BUY', 'LOSS', 'NORMAL_LOSS', -1.05, 38],
  ['A', 'BUY', 'WIN', null, 1.46, 52],
  ['B', 'SELL', 'WIN', null, 1.42, 41],
  ['A', 'BUY', 'LOSS', 'HTF_STRUCTURE_BREAK', -1.06, 27],
  ['A', 'SELL', 'TIME_EXIT', 'TIME_DECAY', -0.28, 120],
  ['C', 'BUY', 'WIN', null, 1.47, 63],
  ['A', 'BUY', 'PARTIAL_WIN', 'SPREAD_COST', 0.25, 71],
  ['B', 'SELL', 'LOSS', 'NO_FOLLOW_THROUGH', -1.03, 18],
  ['B', 'BUY', 'WIN', null, 1.45, 57],
  ['A', 'SELL', 'LOSS', 'NEWS_SHOCK', -1.12, 22],
  ['B', 'BUY', 'CANCELLED', null, null, 3],
  ['A', 'BUY', 'WIN', null, 1.48, 49],
  ['A', 'SELL', 'PARTIAL_WIN', 'LIQUIDITY_DROP', 0.42, 66],
  ['B', 'SELL', 'LOSS', 'STOP_HUNT_REVERSAL', -1.04, 33],
  ['A', 'BUY', 'WIN', null, 1.44, 45],
  ['A', 'SELL', 'LOSS', 'NORMAL_LOSS', -1.02, 40],
  ['A', 'BUY', 'LOSS', 'NORMAL_LOSS', -1.05, 29],
  ['B', 'SELL', 'WIN', null, 1.46, 55],
  ['A', 'BUY', 'TIME_EXIT', 'TIME_DECAY', -0.12, 120],
  ['A', 'SELL', 'WIN', null, 1.49, 61],
  ['A', 'BUY', 'PARTIAL_WIN', 'NORMAL_LOSS', 0.45, 82],
  ['B', 'BUY', 'LOSS', 'REGIME_SHIFT', -1.06, 47],
  ['A', 'BUY', 'WIN', null, 1.47, 51],
  ['A', 'SELL', 'LOSS', 'NO_FOLLOW_THROUGH', -1.03, 16],
  ['C', 'BUY', 'PARTIAL_WIN', 'HTF_STRUCTURE_BREAK', 0.44, 77],
  ['B', 'SELL', 'WIN', null, 1.41, 44],
  ['A', 'BUY', 'LOSS', 'HTF_STRUCTURE_BREAK', -1.07, 36],
  ['A', 'BUY', 'WIN', null, 1.46, 58],
  ['A', 'SELL', 'DATA_INVALID', null, null, 37],
  ['B', 'BUY', 'TIME_EXIT', 'TIME_DECAY', -0.41, 120],
  ['A', 'BUY', 'WIN', null, 1.45, 48],
  ['A', 'SELL', 'LOSS', 'NORMAL_LOSS', -1.04, 31],
  ['C', 'BUY', 'LOSS', 'NORMAL_LOSS', -1.03, 43],
  ['B', 'SELL', 'LOSS', 'NEWS_SHOCK', -1.15, 14],
  ['A', 'BUY', 'PARTIAL_WIN', 'NORMAL_LOSS', 0.38, 74],
  ['A', 'SELL', 'TIME_EXIT', 'NORMAL_LOSS', 0.21, 120],
  ['A', 'BUY', 'LOSS', 'STOP_HUNT_REVERSAL', -1.05, 25],
  ['B', 'SELL', 'WIN', null, 1.44, 53],
  ['C', 'BUY', 'PARTIAL_WIN', 'NORMAL_LOSS', 0.47, 74],
  ['B', 'SELL', 'LOSS', 'NO_FOLLOW_THROUGH', -1.04, 15],
  ['A', 'BUY', 'WIN', null, 1.47, 46],
];

/** The signal of the preview state "a loss was just closed": its review is still preliminary. */
const FRESH_LOSS: PlanRow = ['B', 'SELL', 'LOSS', 'NO_FOLLOW_THROUGH', -1.04, 60];
export const FRESH_LOSS_SEQ = 42;

/** Entry and risk of the signals that were always there (seq 39 to 41), so the dashboard rows stay as they were. */
const FIXED: Readonly<Record<number, { entry: number; risk: number; hoursAgo: number }>> = {
  39: { entry: 4004.3, risk: 4.9, hoursAgo: 52 },
  40: { entry: 4021.6, risk: 6.1, hoursAgo: 30 },
  41: { entry: 4009.1, risk: 5.8, hoursAgo: 3 },
};

/** What the review says about each cause: the numbers behind the rule (02_Signal_Engine section 12). */
type CauseEvidence = Record<string, string | number | boolean>;

/** One result of a review: the primary cause or a supporting one. */
export interface CauseFinding {
  readonly code: CauseCode;
  readonly evidence: CauseEvidence;
}

export interface Trade {
  readonly seq: number;
  readonly signal: Signal;
  readonly result: Result;
  readonly outcome: Outcome;
  readonly generatedMs: number;
  readonly closedMs: number;
  /** The causes of the automatic review, primary first; null when the result has no review. */
  readonly causes: readonly CauseFinding[] | null;
  readonly weakGroups: readonly { group: QualityGroup; state: 'WEAK' | 'FAIL' }[];
  /** Seen after the close: how many 5m candles later price reached TP1, or null. Known only in the final review. */
  readonly candlesToTp1After: number | null;
  readonly snapshotPruned: boolean;
  readonly tp1Ms: number | null;
}

// ---------------------------------------------------------------------------------------------
// Times

function weekend(ms: number): boolean {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

/** The generation time of every signal: seq 39 to 41 relative to the anchor, older ones on weekdays between 02:00 and 18:00 UTC. */
function generationTimes(anchorMs: number): number[] {
  const times: number[] = [];
  for (const [seq, fixed] of Object.entries(FIXED)) {
    times[Number(seq) - 1] = anchorMs - fixed.hoursAgo * HOUR_MS;
  }
  let day = Math.floor((anchorMs - 52 * HOUR_MS) / DAY_MS) * DAY_MS;
  for (let seq = 38; seq >= 1; seq -= 1) {
    const next = times[seq] ?? anchorMs;
    day -= (1 + Math.floor(hash01(seq, 21) * 3)) * DAY_MS;
    const hour = 2 + Math.floor(hash01(seq, 22) * 16);
    const minute = Math.floor(hash01(seq, 23) * 60);
    let at = day + hour * HOUR_MS + minute * MINUTE_MS;
    // the 5-hour chart windows of two signals never overlap
    while (weekend(at) || at > next - 13 * HOUR_MS) at -= DAY_MS;
    day = Math.floor(at / DAY_MS) * DAY_MS;
    times[seq - 1] = at;
  }
  return times;
}

// ---------------------------------------------------------------------------------------------
// Signals

const BASE_STRENGTHS: Readonly<Record<Letter, Strengths>> = {
  A: {
    trend: 0.85,
    structure: 0.85,
    trigger: 0.7,
    volatility: 0.7,
    execution: 0.82,
    sessionMacro: 0.65,
    reward: 0.6,
  },
  B: {
    trend: 0.5,
    structure: 0.82,
    trigger: 0.72,
    volatility: 0.7,
    execution: 0.8,
    sessionMacro: 0.62,
    reward: 0.58,
  },
  C: {
    trend: 0.72,
    structure: 0.8,
    trigger: 0.72,
    volatility: 0.72,
    execution: 0.8,
    sessionMacro: 0.65,
    reward: 0.6,
  },
};

/** The group that was weak when the signal was taken, for the causes whose story starts there. */
export const WEAK_BY_CAUSE: Partial<Record<CauseCode, QualityGroup>> = {
  NO_FOLLOW_THROUGH: 'trigger',
  HTF_STRUCTURE_BREAK: 'structure',
  NEWS_SHOCK: 'sessionMacro',
  LIQUIDITY_DROP: 'sessionMacro',
  SPREAD_COST: 'execution',
  REGIME_SHIFT: 'trend',
  TIME_DECAY: 'reward',
};

const WEAK_TEXT: Readonly<Record<QualityGroup, string>> = {
  trend: '1h momentum flat',
  structure: '15m structure not clean',
  trigger: 'Trigger candle small (0.9 x ATR)',
  volatility: 'ATR percentile low',
  execution: 'Spread above the 60th percentile',
  sessionMacro: 'High-impact event within 90 minutes',
  reward: 'Room to the next level only 1.1R',
};

const WEAK_FACTS: Readonly<Record<QualityGroup, Facts[QualityGroup]>> = {
  trend: [
    { label: '1h EMA', value: '20>50, flat' },
    { label: 'ADX(1h)', value: '17 falling' },
  ],
  structure: [{ label: '15m structure', value: 'choppy, last swing not broken' }],
  trigger: [
    { label: 'Trigger 5m', value: 'small candle, 0.9 x ATR' },
    { label: 'RSI(14)', value: '49 flat' },
  ],
  volatility: [{ label: 'ATR percentile', value: '18th' }],
  execution: [
    { label: 'Spread', value: 0.34 },
    { label: 'Spread percentile', value: '71st' },
  ],
  sessionMacro: [
    { label: 'Session', value: 'last hour before the close' },
    { label: 'High-impact USD event', value: 'in 75 min' },
  ],
  reward: [{ label: 'Room to the next level', value: '6.9 USD' }],
};

function strengthsFor(letter: Letter, seq: number, cause: CauseCode | null): Strengths {
  const base = BASE_STRENGTHS[letter];
  const weakGroup = cause ? WEAK_BY_CAUSE[cause] : undefined;
  const out: Record<QualityGroup, number> = { ...base };
  QUALITY_GROUPS.forEach((group, index) => {
    const jitter = (hash01(seq * 7 + index, 31) - 0.5) * 0.12;
    out[group] = Math.min(0.98, Math.max(0.55, Math.round((base[group] + jitter) * 100) / 100));
  });
  // Sweep reversals trade against the 1h trend, so that group is weak by design.
  const weakByDesign = new Set<QualityGroup>();
  if (letter === 'B') {
    out.trend = Math.round((0.38 + hash01(seq, 32) * 0.06) * 100) / 100;
    weakByDesign.add('trend');
  }
  if (weakGroup) {
    out[weakGroup] = Math.round((0.3 + hash01(seq, 33) * 0.12) * 100) / 100;
    weakByDesign.add(weakGroup);
  }
  // A signal exists only from the lowest grade on (65): the other groups make up for the weak ones.
  for (let round = 0; round < 20 && weightedScore(out) < 67; round += 1) {
    for (const group of QUALITY_GROUPS) {
      if (!weakByDesign.has(group))
        out[group] = Math.min(0.98, Math.round((out[group] + 0.03) * 100) / 100);
    }
  }
  return out;
}

function evidenceFor(letter: Letter, seq: number, plan: readonly PlanRow[]): Evidence {
  if (letter === 'A') {
    return {
      scope: 'BACKTEST_OOS',
      level: 2,
      n: 214,
      wins: 118,
      sampleLabel: 'NORMAL',
      winRate: 0.551,
      ci: [0.484, 0.617],
      expectancyR: 0.13,
      profitFactor: 1.29,
      tp1Rate: 0.523,
      tp2Rate: 0.341,
    };
  }
  if (letter === 'C')
    return {
      ...FORWARD_LOW_SAMPLE,
      scope: 'BACKTEST_OOS',
      level: 3,
      n: 64,
      wins: 35,
      winRate: 0.547,
      ci: [0.426, 0.663],
      expectancyR: 0.13,
      profitFactor: 1.29,
      tp1Rate: 0.531,
      tp2Rate: 0.344,
    };
  // Sweep reversals have only their own forward trades so far: the valid ones before this signal.
  const before = plan.slice(0, seq - 1).filter((row) => row[0] === 'B' && row[4] !== null);
  return {
    scope: 'FORWARD',
    level: 3,
    n: before.length,
    wins: before.filter((row) => (row[4] ?? 0) > 0).length,
    sampleLabel: 'INSUFFICIENT',
    winRate: null,
    ci: null,
    expectancyR: null,
    profitFactor: null,
    tp1Rate: null,
    tp2Rate: null,
  };
}

function specFor(seq: number, row: PlanRow, plan: readonly PlanRow[]): SignalSpec {
  const [letter, side, , cause] = row;
  const strategy = STRATEGIES[letter];
  const fixed = FIXED[seq];
  const dir = side === 'BUY' ? 1 : -1;
  const entry = fixed?.entry ?? Math.round((3985 + hash01(seq, 11) * 55) * 100) / 100;
  const risk = fixed?.risk ?? Math.round((4.6 + hash01(seq, 13) * 3) * 100) / 100;
  const strengths = strengthsFor(letter, seq, cause);
  const weak = QUALITY_GROUPS.filter((group) => strengths[group] < 0.5);
  const facts: Record<QualityGroup, Facts[QualityGroup]> = { ...strategy.facts };
  for (const group of weak) facts[group] = WEAK_FACTS[group];
  return {
    seq,
    side,
    strategyKey: strategy.key,
    strategyName: strategy.name,
    entry,
    stop: round3(entry - dir * risk),
    maxValidEntry: round3(entry + dir * 0.17),
    atr5: Math.round((risk / 1.5) * 10) / 10,
    strengths,
    facts,
    weak: weak.map((group) => WEAK_TEXT[group]),
    researchOnly: [{ label: 'DXY 15m', value: side === 'BUY' ? '-0.2%' : '+0.2%' }],
    warnings: [UNVALIDATED],
    headlines: [],
    evidence: evidenceFor(letter, seq, plan),
    open: { count: 0, riskR: 0 },
    regime:
      letter === 'B'
        ? 'RANGE'
        : letter === 'C'
          ? 'BREAKOUT'
          : side === 'BUY'
            ? 'TREND_UP'
            : 'TREND_DOWN',
    volBucket: cause === 'NEWS_SHOCK' ? 'HIGH' : hash01(seq, 41) < 0.2 ? 'LOW' : 'NORMAL',
  };
}

// ---------------------------------------------------------------------------------------------
// Outcomes and reviews

const EXIT_REASON: Readonly<Record<Result, string>> = {
  WIN: 'TP2',
  PARTIAL_WIN: 'SL_AT_ENTRY',
  LOSS: 'SL',
  TIME_EXIT: 'TIME_STOP',
  CANCELLED: 'ENTRY_EXPIRED',
  DATA_INVALID: 'FEED_GAP',
};

function causeEvidence(
  code: CauseCode,
  seq: number,
  mfeR: number,
  netR: number | null,
): CauseEvidence {
  switch (code) {
    case 'NO_FOLLOW_THROUGH':
      return { maxFavourableR: mfeR, limitR: 0.3 };
    case 'STOP_HUNT_REVERSAL':
      return { candlesToTp1AfterStop: 4 + (seq % 5), limitCandles: 12 };
    case 'NEWS_SHOCK':
      return { event: 'US CPI', atrVersusMedian: 2.8, adverseMoveAtr: 1.9 };
    case 'HTF_STRUCTURE_BREAK':
      return { timeframe: '15m', break: 'CHoCH against the position' };
    case 'REGIME_SHIFT':
      return { regimeAtEntry: 'RANGE', regimeAtClose: 'TREND_UP' };
    case 'LIQUIDITY_DROP':
      return { session: 'LONDON', minutesBeforeSessionEnd: 14 };
    case 'SPREAD_COST':
      return { costR: 0.25, shareOfRisk: 0.25 };
    case 'TIME_DECAY':
      return { netR: netR ?? 0, minutesInTrade: 120 };
    case 'NORMAL_LOSS':
      return { withinExpectedLossFrequency: true };
  }
}

/** Supporting causes of a few signals, so that the review shows more than one line. */
const SUPPORTING: Readonly<Record<number, readonly CauseCode[]>> = {
  4: ['REGIME_SHIFT'],
  10: ['SPREAD_COST'],
  34: ['LIQUIDITY_DROP'],
};

interface Built {
  readonly outcome: Outcome;
  readonly mfeR: number;
  readonly tp1Ms: number | null;
}

function outcomeFor(seq: number, row: PlanRow, signal: Signal, generatedMs: number): Built {
  const [, side, result, cause, netR, minutes] = row;
  const dir = side === 'BUY' ? 1 : -1;
  const closedMs = generatedMs + minutes * MINUTE_MS;
  const risk = signal.riskDistance;
  const jitter = (salt: number) => hash01(seq, salt);
  const r3 = (value: number) => Math.round(value * 1000) / 1000;

  let gross: number | null = null;
  let exitPrice: number | null = null;
  let mfeR: number | null = null;
  let maeR: number | null = null;
  let tp1Ms: number | null = null;
  let tp2Hit = false;
  switch (result) {
    case 'WIN':
      gross = 1.5;
      exitPrice = signal.tp2;
      mfeR = r3(2 + jitter(51) * 0.35);
      maeR = r3(-(0.15 + jitter(52) * 0.4));
      tp1Ms = generatedMs + Math.round(minutes * 0.4) * MINUTE_MS;
      tp2Hit = true;
      break;
    case 'PARTIAL_WIN':
      gross = 0.5;
      exitPrice = signal.entry;
      mfeR = r3(1.05 + jitter(53) * 0.4);
      maeR = r3(-(0.1 + jitter(54) * 0.25));
      tp1Ms = generatedMs + Math.round(minutes * 0.35) * MINUTE_MS;
      break;
    case 'LOSS':
      gross = -1;
      exitPrice = signal.stopLoss;
      mfeR = r3(cause === 'NO_FOLLOW_THROUGH' ? 0.04 + jitter(55) * 0.2 : 0.1 + jitter(55) * 0.45);
      maeR = r3(-(1 + jitter(56) * 0.05));
      break;
    case 'TIME_EXIT':
      gross = r3((netR ?? 0) + 0.03);
      exitPrice = round3(signal.entry + dir * gross * risk);
      mfeR = r3(Math.max(0.2, gross + 0.25 + jitter(57) * 0.3));
      maeR = r3(-(0.2 + jitter(58) * 0.4));
      break;
    case 'CANCELLED':
    case 'DATA_INVALID':
      break;
  }
  const net = netR;
  const cost = gross === null || net === null ? 0 : r3(gross - net);

  const outcome = outcomeSchema.parse({
    signalId: signal.id,
    result,
    countsInStats: net !== null,
    closedAt: new Date(closedMs).toISOString(),
    exitPrice,
    exitReason: EXIT_REASON[result],
    realizedRGross: gross,
    costR: cost,
    realizedRNet: net,
    durationS: minutes * 60,
    mfeR,
    maeR,
    tp1Hit: tp1Ms !== null,
    tp2Hit,
    ambiguous: seq === 17,
    isWin: net !== null && net > 0,
    meta: result === 'CANCELLED' ? { reason: 'Price moved beyond the maximum valid entry' } : {},
  });
  return { outcome, mfeR: mfeR ?? 0, tp1Ms };
}

/** How many 5m candles after the close price reached TP1 (the counterfactual of the final review), or null. */
function candlesToTp1(seq: number, row: PlanRow): number | null {
  const [, , result, cause] = row;
  if (cause === 'STOP_HUNT_REVERSAL') return 4 + (seq % 5);
  if (result === 'TIME_EXIT' && seq % 2 === 1) return 6 + (seq % 4);
  if (result === 'PARTIAL_WIN' && seq % 3 === 1) return 5 + (seq % 5);
  return null;
}

function buildTrade(
  seq: number,
  row: PlanRow,
  plan: readonly PlanRow[],
  generatedMs: number,
): Trade {
  const spec = specFor(seq, row, plan);
  const signal = buildSignalFrom(spec, generatedMs);
  const { outcome, mfeR, tp1Ms } = outcomeFor(seq, row, signal, generatedMs);
  const [, , result, cause, netR] = row;
  const reviewed = cause !== null;
  const causes = reviewed
    ? [
        { code: cause, evidence: causeEvidence(cause, seq, mfeR, netR) },
        ...(SUPPORTING[seq] ?? []).map((code) => ({
          code,
          evidence: causeEvidence(code, seq, mfeR, netR),
        })),
      ]
    : null;
  const weakGroups = signal.groupedScores.flatMap((g) =>
    g.state === 'WEAK' || g.state === 'FAIL' ? [{ group: g.key, state: g.state }] : [],
  );
  return {
    seq,
    signal,
    result,
    outcome,
    generatedMs,
    closedMs: Date.parse(outcome.closedAt),
    causes,
    weakGroups,
    candlesToTp1After: reviewed ? candlesToTp1(seq, row) : null,
    snapshotPruned: seq === PRUNED_SEQ,
    tp1Ms,
  };
}

/** The 41 finished signals, oldest first. `anchorMs` is the moment the preview started. */
export function buildTrades(anchorMs: number): Trade[] {
  const times = generationTimes(anchorMs);
  return PLAN.map((row, index) => buildTrade(index + 1, row, PLAN, times[index] ?? anchorMs));
}

/** The loss of the preview state "review pending": closed 35 minutes before `activatedMs`, so its review is still preliminary. */
export function buildFreshLoss(activatedMs: number): Trade {
  const minutes = FRESH_LOSS[5];
  return buildTrade(
    FRESH_LOSS_SEQ,
    FRESH_LOSS,
    [...PLAN, FRESH_LOSS],
    activatedMs - (35 + minutes) * MINUTE_MS,
  );
}

// ---------------------------------------------------------------------------------------------
// What the API says about a finished signal at a given moment

function autopsyStatus(trade: Trade, nowMs: number): 'PRELIMINARY' | 'FINAL' | null {
  if (trade.causes === null) return null;
  return nowMs >= trade.closedMs + REVIEW_FINAL_AFTER_MS ? 'FINAL' : 'PRELIMINARY';
}

export function rowOfTrade(trade: Trade, nowMs: number): SignalHistoryRow {
  const { signal: s, outcome: o } = trade;
  return signalHistoryRowSchema.parse({
    signalId: s.id,
    seq: s.seq,
    generatedAt: s.generatedAt,
    side: s.side,
    mode: s.mode,
    strategyKey: s.strategyKey,
    strategyVersion: s.strategyVersion,
    strategyStatus: 'FORWARD_TESTING',
    exitProfile: s.exitProfile,
    entry: s.entry,
    stopLoss: s.stopLoss,
    tp1: s.tp1,
    tp2: s.tp2,
    riskDistance: s.riskDistance,
    regime: s.regime,
    session: s.session,
    volBucket: s.volBucket,
    newsState: s.newsState,
    qualityScore: s.qualityScore,
    openSignalsAtEntry: s.openSignalsAtEntry,
    warnings: s.warnings,
    evidenceWinRate: s.evidence.winRate,
    evidenceN: s.evidence.n,
    state: 'CLOSED',
    result: o.result,
    countsInStats: o.countsInStats,
    isWin: o.isWin,
    closedAt: o.closedAt,
    exitPrice: o.exitPrice,
    exitReason: o.exitReason,
    realizedRNet: o.realizedRNet,
    mfeR: o.mfeR,
    maeR: o.maeR,
    durationS: o.durationS,
    tp1Hit: o.tp1Hit,
    tp2Hit: o.tp2Hit,
    ambiguous: o.ambiguous,
    primaryCause: trade.causes?.[0]?.code ?? null,
    autopsyStatus: autopsyStatus(trade, nowMs),
  });
}

function eventsOf(trade: Trade, nowMs: number): SignalEvent[] {
  const { signal, outcome, generatedMs, closedMs } = trade;
  let id = trade.seq * 100;
  const events: SignalEvent[] = [];
  const add = (
    eventType: SignalEvent['eventType'],
    atMs: number,
    price: number | null,
    meta: SignalEvent['meta'] = {},
  ) => {
    if (atMs > nowMs) return;
    id += 1;
    events.push(
      signalEventSchema.parse({
        id,
        signalId: signal.id,
        eventType,
        eventAt: new Date(atMs).toISOString(),
        price,
        meta,
      }),
    );
  };
  add('CREATED', generatedMs, signal.entry);
  add('ALERT_QUEUED', generatedMs + 2000, null, { kind: 'SIGNAL_NEW' });
  if (trade.tp1Ms !== null) {
    add('TP1_HIT', trade.tp1Ms, signal.tp1, { closed: '50%' });
    add('STOP_MOVED_TO_ENTRY', trade.tp1Ms + 1000, signal.entry);
  }
  const exit: Partial<Record<Result, SignalEvent['eventType']>> = {
    WIN: 'TP2_HIT',
    PARTIAL_WIN: 'SL_HIT',
    LOSS: 'SL_HIT',
    TIME_EXIT: 'TIME_EXIT',
    CANCELLED: 'CANCELLED',
    DATA_INVALID: 'DATA_INVALID',
  };
  const exitType = exit[trade.result];
  if (exitType) {
    add(exitType, closedMs, outcome.exitPrice, {
      exitReason: outcome.exitReason,
      ...(trade.result === 'PARTIAL_WIN' ? { atEntry: true } : {}),
    });
  }
  if (trade.causes) {
    add('AUTOPSY_PRELIMINARY', closedMs + 4000, null, {
      primaryCause: trade.causes[0]?.code ?? '',
    });
    add('AUTOPSY_FINAL', closedMs + REVIEW_FINAL_AFTER_MS, null, {
      primaryCause: trade.causes[0]?.code ?? '',
    });
  }
  return events;
}

function autopsyOf(trade: Trade, nowMs: number): Autopsy | null {
  const status = autopsyStatus(trade, nowMs);
  if (status === null || trade.causes === null) return null;
  const finalMs = trade.closedMs + REVIEW_FINAL_AFTER_MS;
  const reached = trade.candlesToTp1After !== null;
  return autopsySchema.parse({
    signalId: trade.signal.id,
    status,
    primaryCause: trade.causes[0]?.code,
    causes: trade.causes.map((c) => ({ code: c.code, evidence: c.evidence })),
    weakGroupsAtEntry: trade.weakGroups,
    // price after the close is only observed for 60 minutes: the final review has the counterfactual
    counterfactual:
      status === 'FINAL'
        ? {
            reachedTp1: reached,
            candlesToTp1: trade.candlesToTp1After,
            reachedTp2: false,
            candlesToTp2: null,
          }
        : null,
    computedAt: new Date(status === 'FINAL' ? finalMs : trade.closedMs + 4000).toISOString(),
    finalizedAt: status === 'FINAL' ? new Date(finalMs).toISOString() : null,
  });
}

export function detailOfTrade(trade: Trade, nowMs: number): SignalDetail {
  return signalDetailSchema.parse({
    signal: trade.signal,
    state: null,
    events: eventsOf(trade, nowMs),
    outcome: trade.outcome,
    autopsy: autopsyOf(trade, nowMs),
    snapshotAvailable: !trade.snapshotPruned,
  });
}

/** The stored feature snapshot (a few of the features, as plain JSON). `null` once retention has removed it. */
export function snapshotOfSignal(signal: Signal, pruned: boolean): FeatureSnapshotResponse | null {
  if (pruned) return null;
  return featureSnapshotResponseSchema.parse({
    signalId: signal.id,
    features: {
      symbol: signal.symbol,
      atr5: signal.atr5,
      regime: signal.regime,
      session: signal.session,
      volBucket: signal.volBucket,
      newsState: signal.newsState,
      qualityScore: signal.qualityScore,
      groups: Object.fromEntries(signal.groupedScores.map((g) => [g.key, g.strength])),
      indicators: {
        rsi14: Math.round((38 + hash01(signal.seq, 61) * 30) * 10) / 10,
        adx1h: Math.round((17 + hash01(signal.seq, 62) * 18) * 10) / 10,
        ema20: round3(signal.entry - (signal.side === 'BUY' ? 0.8 : -0.8)),
        macdHistogram: Math.round((hash01(signal.seq, 63) - 0.4) * 100) / 100,
      },
      researchOnly: { dxy15mChangePct: -0.2, silver15mChangePct: 0.3 },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The chart around a trade: 5m candles from 60 before to 60 after, drawn so that they tell the same story as the result

const CANDLE_SAMPLES = 6;

/** The candles of the chart window of a trade, oldest first (closed candles only: nothing after `nowMs`). */
export function tradeCandles(trade: Trade, nowMs: number): CandlesResponse['candles'] {
  const dir = trade.signal.side === 'BUY' ? 1 : -1;
  const { entry, riskDistance: risk } = trade.signal;
  const { outcome } = trade;
  const exitCandle = bucketStart('5m', trade.closedMs);
  const firstCandle = bucketStart('5m', trade.generatedMs) - CHART_CONTEXT_CANDLES * CANDLE_MS;
  const lastCandle = exitCandle + CHART_CONTEXT_CANDLES * CANDLE_MS;
  const tp1Candle = trade.tp1Ms === null ? null : bucketStart('5m', trade.tp1Ms);
  const afterTp1 =
    trade.candlesToTp1After === null ? null : exitCandle + trade.candlesToTp1After * CANDLE_MS;
  const mfe = outcome.mfeR ?? 0.6;
  const mae = outcome.maeR ?? -0.4;
  const result = trade.result;
  const salt = trade.seq * 131;

  // waypoints of the path in R (entry 0, stop -1, TP1 +1, TP2 +2)
  const duration = trade.closedMs - trade.generatedMs;
  const at = (share: number) => trade.generatedMs + duration * share;
  const exitR =
    result === 'WIN'
      ? 2
      : result === 'LOSS'
        ? -1
        : result === 'PARTIAL_WIN'
          ? 0
          : (((outcome.exitPrice ?? entry) - entry) * dir) / risk;
  const points: [number, number][] = [[trade.generatedMs, 0]];
  if (result === 'WIN') points.push([at(0.12), mae], [trade.tp1Ms ?? at(0.4), 1], [at(0.7), 1.5]);
  else if (result === 'PARTIAL_WIN')
    points.push([at(0.12), mae], [trade.tp1Ms ?? at(0.35), 1], [at(0.6), Math.min(mfe, 1.3)]);
  else if (result === 'LOSS') points.push([at(0.3), mfe], [at(0.65), mfe * 0.3]);
  else if (result === 'TIME_EXIT') points.push([at(0.35), mfe], [at(0.7), mae]);
  else if (result === 'CANCELLED') points.push([trade.closedMs, 0.7]);
  else points.push([at(0.4), 0.3], [at(0.7), -0.2]);
  points.push([trade.closedMs, result === 'CANCELLED' ? 0.7 : exitR]);
  if (afterTp1 !== null) points.push([afterTp1 + CANDLE_MS / 2, 1]);
  points.push([lastCandle + CANDLE_MS, afterTp1 === null ? exitR - 0.4 : 0.6]);

  const raw = (ms: number): number => {
    const first = points[0] ?? [0, 0];
    if (ms <= first[0]) {
      const lead = Math.min(1, (first[0] - ms) / (CHART_CONTEXT_CANDLES * CANDLE_MS));
      return -0.3 * lead + 0.35 * lead * Math.sin(ms / 540_000 + salt);
    }
    for (let i = 1; i < points.length; i += 1) {
      const [t1, r1] = points[i] ?? first;
      const [t0, r0] = points[i - 1] ?? first;
      if (ms <= t1) return t1 === t0 ? r1 : r0 + ((r1 - r0) * (ms - t0)) / (t1 - t0);
    }
    return points.at(-1)?.[1] ?? 0;
  };

  const candles: CandlesResponse['candles'] = [];
  const gapFrom = result === 'DATA_INVALID' ? bucketStart('5m', at(0.5)) : null;
  const winOrPartial = result === 'WIN' || result === 'PARTIAL_WIN';
  let previousClose: number | null = null;
  for (let start = firstCandle; start <= lastCandle; start += CANDLE_MS) {
    const during = start >= bucketStart('5m', trade.generatedMs) && start <= exitCandle;
    const exiting = start === exitCandle;
    const tp1Here = start === tp1Candle;
    const tp1Done = tp1Candle !== null && start > tp1Candle;
    // Limits that keep the picture honest: no candle reaches a level before the event that the result tells about.
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    if (during) {
      top = Math.min(0.97, Math.max(mfe, 0.15));
      bottom = Math.max(-0.97, mae);
      if (winOrPartial && tp1Here) top = 1;
      if (winOrPartial && (tp1Here || tp1Done)) {
        // after TP1 the stop sits at entry
        bottom = tp1Here ? bottom : 0.06;
        top = result === 'WIN' ? 1.95 : Math.min(1.95, Math.max(mfe, 1.2));
        if (tp1Here) top = 1;
      }
      if (exiting && result === 'WIN') top = 2;
      if (exiting && result === 'LOSS') bottom = -1;
      if (exiting && result === 'PARTIAL_WIN') bottom = 0;
      if (result === 'CANCELLED') top = 1;
    } else if (start > exitCandle && exitR < 1 && start <= exitCandle + 12 * CANDLE_MS) {
      // within the hour of the final review, TP1 is reached only where the review says so
      if (afterTp1 === null || start < afterTp1) top = 0.97;
    }

    const samples = Array.from({ length: CANDLE_SAMPLES }, (_, k) => {
      const t = start + (k * CANDLE_MS) / (CANDLE_SAMPLES - 1);
      const noise = (hash01(Math.floor(t / 60_000), salt) - 0.5) * 0.22;
      return Math.min(top - 0.02, Math.max(bottom + 0.02, raw(t) + noise));
    });
    const open: number = previousClose ?? samples[0] ?? 0;
    const finishes = exiting && result !== 'CANCELLED' && result !== 'DATA_INVALID';
    const c: number = finishes
      ? exitR
      : Math.min(top - 0.02, Math.max(bottom + 0.02, samples[CANDLE_SAMPLES - 1] ?? open));
    let hi = Math.min(top, Math.max(open, c, ...samples) + hash01(start / 60_000, salt + 1) * 0.12);
    let lo = Math.max(
      bottom,
      Math.min(open, c, ...samples) - hash01(start / 60_000, salt + 2) * 0.12,
    );
    // the candle of each event reaches exactly the level of that event
    if (tp1Here || start === afterTp1) hi = 1;
    if (exiting && result === 'WIN') hi = 2;
    if (exiting && result === 'LOSS') lo = -1;
    if (exiting && result === 'PARTIAL_WIN') lo = 0;
    hi = Math.max(hi, open, c);
    lo = Math.min(lo, open, c);
    previousClose = c;

    if (gapFrom !== null && (start === gapFrom || start === gapFrom + CANDLE_MS)) continue;
    if (start + CANDLE_MS > nowMs) break;
    const price = (r: number) => round3(entry + dir * r * risk);
    candles.push({
      t: new Date(start).toISOString(),
      o: price(open),
      h: price(dir === 1 ? hi : lo),
      l: price(dir === 1 ? lo : hi),
      c: price(c),
    });
  }
  return candles;
}

/** The trade whose chart window contains the candle just before `beforeMs`, if any. */
export function tradeForWindow(trades: readonly Trade[], beforeMs: number): Trade | undefined {
  const last = beforeMs - 1;
  return trades.find((trade) => {
    const start = bucketStart('5m', trade.generatedMs) - CHART_CONTEXT_CANDLES * CANDLE_MS;
    const end = bucketStart('5m', trade.closedMs) + (CHART_CONTEXT_CANDLES + 1) * CANDLE_MS;
    return last >= start && last < end;
  });
}
