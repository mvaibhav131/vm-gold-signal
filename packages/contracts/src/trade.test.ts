import {
  QUALITY_GROUPS,
  RISK_DEFAULTS,
  TradeTracker,
  cancelledOutcome,
  findFill,
  planTrade,
  scoreQuality,
  tradeSpecOf,
  type ExitProfile,
  type PlanInput,
  type QualityStrengths,
  type QualityWeights,
  type RiskParams,
  type Side,
  type TradeEvent,
  type TradeOutcome,
  type TradePlan,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { outcomeSchema, signalDraftSchema, signalEventSchema, signalStateSchema } from './signal';
import { SIGNAL_ID, signalDraft, signalState } from './test-fixtures';

// The trade model and the quality score of core, held against the contracts of the API and the database:
// what the worker computes must be what the schemas accept, with times as ISO strings.

const DECIDED_AT = Date.parse('2026-10-23T06:10:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** A SELL is the BUY seen upside down around 8000. */
const flip = (price: number) => Math.round((8000 - price) * 1000) / 1000;

const WEIGHTS: QualityWeights = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.1,
  execution: 0.12,
  sessionMacro: 0.12,
  reward: 0.08,
};
const STRENGTHS: QualityStrengths = {
  trend: 0.8,
  structure: 0.9,
  trigger: 0.7,
  volatility: 0.6,
  execution: 0.8,
  sessionMacro: 0.5,
  reward: 0.4,
};

function planOf(side: Side, exitProfile: ExitProfile, risk: Partial<RiskParams> = {}): TradePlan {
  const buy = side === 'BUY';
  const input: PlanInput = {
    side,
    decidedAt: DECIDED_AT,
    quote: buy
      ? { t: DECIDED_AT, bid: 4017.25, ask: 4017.32 }
      : { t: DECIDED_AT, bid: flip(4017.32), ask: flip(4017.25) },
    stopLoss: buy ? 4010.9 : flip(4010.9),
    atr5: 4.3,
    structureTarget: buy ? 4027 : flip(4027),
    minMeasuredMoveR: null,
  };
  const result = planTrade(input, { ...RISK_DEFAULTS, exitProfile, ...risk });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

describe('a signal built from the trade model and the score', () => {
  it.each(['BUY', 'SELL'] as const)('%s: every profile gives a valid draft', (side) => {
    for (const exitProfile of ['EP1_PARTIAL', 'EP2_SINGLE', 'EP3_STRUCTURE'] as const) {
      const plan = planOf(side, exitProfile);
      const quality = scoreQuality(STRENGTHS, WEIGHTS);
      expect(quality.score).toBe(72);
      expect(quality.grade).toBe('Moderate');
      const base = signalDraft();
      const draft = {
        ...base,
        side,
        exitProfile,
        generatedAt: iso(plan.decidedAt),
        sourceAt: iso(plan.decidedAt),
        entry: plan.entry,
        maxValidEntry: plan.maxValidEntry,
        entryValidUntil: iso(plan.entryValidUntil),
        stopLoss: plan.stopLoss,
        tp1: plan.tp1,
        tp2: plan.tp2,
        riskDistance: plan.riskDistance,
        timeStopAt: iso(plan.timeStopAt),
        qualityScore: quality.score,
        groupedScores: quality.groups,
        explanation: {
          ...base.explanation,
          quality: { score: quality.score, grade: quality.grade },
          levels: {
            entry: plan.entry,
            maxValidEntry: plan.maxValidEntry,
            stop: plan.stopLoss,
            tp1: plan.tp1,
            tp2: plan.tp2,
            riskUsd: plan.riskDistance,
          },
        },
      };
      const parsed = signalDraftSchema.safeParse(draft);
      expect(parsed.error?.issues ?? [], `${side} ${exitProfile}`).toEqual([]);
    }
  });

  it('a group without data is NA and still passes the schema', () => {
    const quality = scoreQuality({ ...STRENGTHS, reward: null }, WEIGHTS);
    expect(quality.groups.map((group) => group.key)).toEqual([...QUALITY_GROUPS]);
    expect(quality.groups.at(-1)).toEqual({ key: 'reward', state: 'NA', strength: null });
    const base = signalDraft();
    const draft = {
      ...base,
      groupedScores: quality.groups,
      qualityScore: quality.score ?? 0,
      explanation: {
        ...base.explanation,
        quality: { score: quality.score ?? 0, grade: quality.grade },
      },
    };
    expect(signalDraftSchema.safeParse(draft).error?.issues ?? []).toEqual([]);
  });

  it('a setup below the lowest grade has no grade, and the schema refuses it', () => {
    const quality = scoreQuality({ ...STRENGTHS, trend: 0, structure: 0 }, WEIGHTS);
    expect(quality.grade).toBeNull();
    const base = signalDraft();
    const draft = {
      ...base,
      groupedScores: quality.groups,
      qualityScore: quality.score ?? 0,
      explanation: { ...base.explanation, quality: { score: quality.score ?? 0, grade: null } },
    };
    expect(signalDraftSchema.safeParse(draft).success).toBe(false);
  });
});

/** Fills a plan at its confirming tick and feeds the closing-side prices (given in the frame of a BUY). */
function follow(
  side: Side,
  exitProfile: ExitProfile,
  prices: readonly (readonly [seconds: number, price: number])[],
  risk: Partial<RiskParams> = {},
) {
  const plan = planOf(side, exitProfile, risk);
  const confirming = {
    t: DECIDED_AT,
    bid: side === 'BUY' ? plan.entryRef - 0.07 : plan.entryRef,
    ask: side === 'BUY' ? plan.entryRef : plan.entryRef + 0.07,
  };
  const filled = findFill(plan, [confirming], { ...RISK_DEFAULTS, ...risk });
  if (filled.kind !== 'FILLED') throw new Error(filled.reason);
  const tracker = new TradeTracker(tradeSpecOf(plan, filled));
  const events: TradeEvent[] = [];
  const states = [tracker.state];
  for (const [seconds, price] of prices) {
    const real = side === 'BUY' ? price : flip(price);
    events.push(
      ...tracker.observeTick({
        t: DECIDED_AT + seconds * 1000,
        bid: side === 'BUY' ? real : Math.round((real - 0.07) * 1000) / 1000,
        ask: side === 'BUY' ? Math.round((real + 0.07) * 1000) / 1000 : real,
      }),
    );
    states.push(tracker.state);
  }
  return { tracker, events, states };
}

function closed(tracker: TradeTracker): TradeOutcome {
  if (tracker.outcome === null) throw new Error('the trade is still open');
  return tracker.outcome;
}

const toOutcome = (o: TradeOutcome) => ({
  signalId: SIGNAL_ID,
  ...o,
  closedAt: iso(o.closedAt),
  meta: {},
});

describe('the outcome of a trade is an outcome that the schema accepts', () => {
  const PARTIAL_PATH: readonly (readonly [number, number])[] = [
    [10, 4024.5],
    [20, 4017.37],
  ];
  const paths: Record<string, readonly (readonly [number, number])[]> = {
    LOSS: [
      [10, 4015],
      [20, 4010.5],
    ],
    PARTIAL_WIN: PARTIAL_PATH,
    WIN: [
      [10, 4024.5],
      [20, 4031],
    ],
    TIME_EXIT: [
      [30, 4019],
      [60, 4020],
    ],
    DATA_INVALID: [[100, 4019]],
  };

  it.each(Object.keys(paths))('%s', (name) => {
    for (const side of ['BUY', 'SELL'] as const) {
      const { tracker } = follow(side, 'EP1_PARTIAL', paths[name] ?? [], { timeStopMin: 1 });
      const out = closed(tracker);
      expect(out.result, `${side} ${name}`).toBe(name);
      const parsed = outcomeSchema.safeParse(toOutcome(out));
      expect(parsed.error?.issues ?? [], `${side} ${name}`).toEqual([]);
    }
  });

  it('with a commission, net is below gross and still consistent', () => {
    const { tracker } = follow('BUY', 'EP1_PARTIAL', PARTIAL_PATH, {
      commissionUsdPerOz: 3.2,
    });
    const out = closed(tracker);
    expect(out).toMatchObject({
      realizedRGross: 0.5,
      costR: 0.495,
      realizedRNet: 0.005,
      isWin: true,
    });
    expect(outcomeSchema.safeParse(toOutcome(out)).success).toBe(true);
  });

  it('a net of zero is a counted trade that is not a win', () => {
    const { tracker } = follow('BUY', 'EP1_PARTIAL', PARTIAL_PATH, {
      commissionUsdPerOz: 3.235,
    });
    const out = closed(tracker);
    expect(out).toMatchObject({ result: 'PARTIAL_WIN', realizedRNet: 0, isWin: false });
    expect(outcomeSchema.safeParse(toOutcome(out)).success).toBe(true);
  });

  it('a signal that could not be followed is a CANCELLED outcome', () => {
    const cancelled = cancelledOutcome(DECIDED_AT + 5000);
    expect(outcomeSchema.safeParse(toOutcome(cancelled)).error?.issues ?? []).toEqual([]);
  });
});

describe('the events and the state of a trade are what the tables store', () => {
  const rowOf = (event: TradeEvent, id: number) => ({
    id,
    signalId: SIGNAL_ID,
    eventType: event.type,
    eventAt: iso(event.at),
    price: event.price,
    meta: {},
  });

  it('every event of a full EP1 win is a valid signal event', () => {
    const { events } = follow('BUY', 'EP1_PARTIAL', [
      [10, 4024.5],
      [20, 4031],
    ]);
    expect(events.map((event) => event.type)).toEqual([
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
      'TP2_HIT',
    ]);
    events.forEach((event, index) => {
      expect(signalEventSchema.safeParse(rowOf(event, index + 1)).error?.issues ?? []).toEqual([]);
    });
  });

  it('the stop at a loss and the data gap are valid events', () => {
    const loss = follow('SELL', 'EP2_SINGLE', [[10, 4010]]).events;
    expect(loss.map((event) => event.type)).toEqual(['SL_HIT']);
    const gap = follow('BUY', 'EP1_PARTIAL', [[100, 4019]]).events;
    expect(gap).toEqual([{ type: 'DATA_INVALID', at: DECIDED_AT + 100_000, price: null }]);
    for (const event of [...loss, ...gap]) {
      expect(signalEventSchema.safeParse(rowOf(event, 1)).error?.issues ?? []).toEqual([]);
    }
  });

  it('the time exit is a valid event', () => {
    const { events } = follow('BUY', 'EP1_PARTIAL', [[60, 4020]], { timeStopMin: 1 });
    expect(events.map((event) => event.type)).toEqual(['TIME_EXIT']);
    for (const event of events) {
      expect(signalEventSchema.safeParse(rowOf(event, 1)).success).toBe(true);
    }
  });

  it('every state on the way is a valid signal state', () => {
    for (const side of ['BUY', 'SELL'] as const) {
      const { states } = follow(side, 'EP1_PARTIAL', [
        [10, 4015],
        [20, 4024.5],
        [30, 4021],
        [40, 4017],
      ]);
      expect(states.map((state) => state.status)).toEqual([
        'ACTIVE',
        'ACTIVE',
        'TP1_HIT',
        'TP1_HIT',
        'CLOSED',
      ]);
      states.forEach((state, index) => {
        const row = {
          ...signalState(),
          status: state.status,
          stopLossCurrent: state.stopLossCurrent,
          tp1HitAt: state.tp1HitAt === null ? null : iso(state.tp1HitAt),
          mfeR: state.mfeR,
          maeR: state.maeR,
          updatedAt: iso(DECIDED_AT + index * 10_000),
        };
        expect(signalStateSchema.safeParse(row).error?.issues ?? [], `${side} ${index}`).toEqual(
          [],
        );
      });
    }
  });
});
