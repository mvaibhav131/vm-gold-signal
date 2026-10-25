import {
  RISK_DEFAULTS,
  buildExplanation,
  checkTelegramHtml,
  planTrade,
  qualityStrengths,
  renderFinalReview,
  renderSignalCancelled,
  renderSignalClosed,
  renderSignalNew,
  renderSignalTp1,
  scoreQuality,
  warningsOf,
  type ExplanationDoc,
  type ExplanationEvidence,
  type ExplanationInput,
  type QualityInputs,
  type QualityWeights,
  type Side,
  type SignalRef,
  type TradeOutcome,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { explanationSchema, evidenceSchema, type Explanation } from './explanation';
import { signalDraftSchema } from './signal';
import { SIGNAL_ID, signalDraft } from './test-fixtures';

// The explanation and the messages of core, held against the contracts: what the engine builds must
// be what the schema accepts, and what is stored must be what the messages can read.

const DECIDED_AT = Date.parse('2026-10-23T06:10:00Z');

const WEIGHTS: QualityWeights = {
  trend: 0.22,
  structure: 0.22,
  trigger: 0.14,
  volatility: 0.1,
  execution: 0.12,
  sessionMacro: 0.12,
  reward: 0.08,
};

const BUY_INPUTS: QualityInputs = {
  trend: {
    ema20: 4020,
    ema50: 4015,
    ema200: 4000,
    ema50SlopeAtr: 0.5,
    adx: 31,
    plusDI: 30,
    minusDI: 10,
    supertrend: 'UP',
  },
  structure: {
    state15m: 'UP',
    state5m: 'UP',
    breakEvent: 'WITH',
    sweep: null,
    confluence: 2,
    patternMoveR: null,
  },
  trigger: { rangeAtr: 1.4, closeLocation: 0.85, rsiNow: 54, rsiExtreme: 38, macdBars: 3 },
  volatility: { atrPercentile: 62, squeeze: 'NONE' },
  execution: { spreadPercentile: 35, stopAtr: 1.5 },
  sessionMacro: { session: 'LONDON', news: { state: 'CLEAR', minutesToNext: 265 } },
  reward: { tp1Atr: 1.5, levelRoom: 2.3 },
};

const SELL_INPUTS: QualityInputs = {
  ...BUY_INPUTS,
  trend: {
    ema20: 3980,
    ema50: 3985,
    ema200: 4000,
    ema50SlopeAtr: -0.5,
    adx: 31,
    plusDI: 10,
    minusDI: 30,
    supertrend: 'DOWN',
  },
  structure: { ...BUY_INPUTS.structure, state15m: 'DOWN', state5m: 'DOWN' },
  trigger: { rangeAtr: 1.4, closeLocation: 0.15, rsiNow: 46, rsiExtreme: 62, macdBars: -3 },
};

const EVIDENCE: ExplanationEvidence = {
  scope: 'FORWARD',
  level: 2,
  n: 64,
  wins: 37,
  sampleLabel: 'LOW_SAMPLE',
  winRate: 0.58,
  ci: [0.46, 0.69],
  expectancyR: 0.31,
  profitFactor: 1.5,
  tp1Rate: 0.7,
  tp2Rate: 0.4,
};

const INSUFFICIENT: ExplanationEvidence = {
  scope: 'FORWARD',
  level: 4,
  n: 12,
  wins: 7,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
};

function planFor(side: Side) {
  const buy = side === 'BUY';
  const result = planTrade(
    {
      side,
      decidedAt: DECIDED_AT,
      quote: buy
        ? { t: DECIDED_AT, bid: 4017.25, ask: 4017.32 }
        : { t: DECIDED_AT, bid: 3982.68, ask: 3982.75 },
      stopLoss: buy ? 4010.9 : 3989.1,
      atr5: 4.3,
      structureTarget: null,
      minMeasuredMoveR: null,
    },
    RISK_DEFAULTS,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

function inputOf(side: Side, change: Partial<ExplanationInput> = {}): ExplanationInput {
  const inputs = side === 'BUY' ? BUY_INPUTS : SELL_INPUTS;
  return {
    side,
    strategyVersion: '0.1.0',
    setup: {
      strategyKey: 'trend_pullback',
      facts: {
        legStart: { openTime: DECIDED_AT - 3_600_000, price: 4021.3 },
        legExtreme: 4012.8,
        zone: 'EMA+FIB',
        atr: 4.3,
        rsi: 54,
        rsiExtreme: 38,
        breakLevel: 4014.2,
        brokeLevel: true,
        displacement: true,
      },
    },
    plan: planFor(side),
    quality: scoreQuality(qualityStrengths(side, inputs), WEIGHTS),
    inputs,
    market: { atr5: 4.3, spread: 0.07 },
    researchOnly: [{ label: 'DXY 15m', value: '-0.2%' }],
    macro: { state: 'CLEAR', next: { name: 'CPI m/m', at: Date.parse('2026-10-23T12:30:00Z') } },
    news: { feed: 'AVAILABLE', headlines: [] },
    flags: [
      { flag: 'UNVALIDATED_STRATEGY', present: true, detail: { status: 'FORWARD_TESTING' } },
      { flag: 'ROLLOVER', present: false, detail: {} },
    ],
    open: { count: 0, riskR: 0 },
    evidence: EVIDENCE,
    ...change,
  };
}

const parse = (doc: ExplanationDoc) => explanationSchema.safeParse(doc);

describe('the explanation that core builds is an explanation that the schema accepts', () => {
  it.each(['BUY', 'SELL'] as const)('%s', (side) => {
    const doc = buildExplanation(inputOf(side));
    const typed: Explanation = doc; // the two types are assignable, not only equal at runtime
    expect(typed.headline).toBe(doc.headline);
    expect(parse(doc).error?.issues ?? []).toEqual([]);
  });

  it('every strategy, with its own lines', () => {
    const setups: ExplanationInput['setup'][] = [
      {
        strategyKey: 'sweep_reversal',
        facts: {
          levelId: 'PDL',
          level: 4012.4,
          sweepOpenTime: DECIDED_AT - 1_800_000,
          reclaimOpenTime: DECIDED_AT - 1_500_000,
          sweepLow: 4011.5,
          depthAtr: 0.35,
          wickRatio: 0.65,
          candlesSinceReclaim: 3,
          chochLevel: 4016.5,
          displacementAtr: 1.4,
          atr: 3.9,
          choch15m: true,
          rsiDivergence: true,
        },
      },
      {
        strategyKey: 'squeeze_retest',
        facts: {
          level: 4018,
          breakoutOpenTime: DECIDED_AT - 1_200_000,
          candlesSinceBreakout: 4,
          breakoutCloseAtr: 0.4,
          breakoutDisplacementAtr: 1.6,
          adx: 24,
          adxBefore: 18,
          retestExtreme: 4017.8,
          retestDistanceAtr: -0.05,
          wickRatio: 0.4,
          squeezeCandles15m: 22,
          candlesSinceRelease15m: 1,
          atr: 4.1,
        },
      },
      {
        strategyKey: 'trendline_retest',
        facts: {
          lineFrom: DECIDED_AT - 10_800_000,
          lineTo: DECIDED_AT - 5_400_000,
          touches: 3,
          lineValue: 4015.6,
          lineSlope: -0.2,
          breakOpenTime: DECIDED_AT - 1_800_000,
          candlesSinceBreak: 5,
          breakBeyondAtr: 0.3,
          breakBodyRatio: 0.7,
          retestExtreme: 4015.9,
          retestDistanceAtr: 0.2,
          closeAwayAtr: 0.5,
          wickRatio: 0.45,
          rsi: 52.4,
          adx1h: 24,
          adx1hAligned: true,
          stopFromLine: false,
          atr: 4.3,
        },
      },
      {
        strategyKey: 'pattern_breakout',
        facts: {
          pattern: 'DOUBLE_BOTTOM',
          patternFrom: DECIDED_AT - 21_600_000,
          patternTo: DECIDED_AT - 10_800_000,
          height: 12.9,
          breakLevel: 4018,
          level: 4018,
          breakOpenTime: DECIDED_AT - 1_800_000,
          candlesSinceBreak: 3,
          breakBeyondAtr: 0.2,
          breakDisplacementAtr: 1.5,
          alsoBroke: 0,
          retestExtreme: 4017.2,
          retestDistanceAtr: 0.2,
          wickRatio: 0.4,
          target: 4030.9,
          measuredMoveR: 2.1,
          atr: 4.3,
        },
      },
    ];
    for (const setup of setups) {
      const doc = buildExplanation(inputOf('BUY', { setup }));
      expect(parse(doc).error?.issues ?? [], setup.strategyKey).toEqual([]);
    }
  });

  it('with warnings, headlines, weak points, a group without data and a single target', () => {
    const base = inputOf('BUY');
    const weakInputs: QualityInputs = {
      ...BUY_INPUTS,
      reward: { tp1Atr: null, levelRoom: null },
      execution: { spreadPercentile: 96, stopAtr: 1.5 },
    };
    const doc = buildExplanation({
      ...base,
      inputs: weakInputs,
      quality: scoreQuality(qualityStrengths('BUY', weakInputs), WEIGHTS),
      plan: { ...base.plan, tp1: 4027.075, tp2: null },
      flags: [
        { flag: 'NEWS_WINDOW', present: true, detail: { minutesToEvent: 20, settling: false } },
        { flag: 'OPPOSES_OPEN', present: true, detail: { signalIds: [SIGNAL_ID] } },
      ],
      warningContext: { eventName: 'CPI m/m', openLabels: { [SIGNAL_ID]: '#S-0041' } },
      news: {
        feed: 'AVAILABLE',
        headlines: [
          {
            title: 'Fed holds rates',
            sources: ['BBC'],
            publishedAt: '2026-10-23T05:50:00.000Z',
            impact: 'HIGH',
            topics: ['FED_RATES'],
            url: 'https://example.com/a',
            classified: true,
          },
        ],
      },
      open: { count: 1, riskR: 1 },
    });
    expect(doc.weak).toContain('the spread is wide (96th percentile)');
    expect(doc.groups.at(-1)).toMatchObject({ key: 'reward', state: 'NA', facts: [] });
    expect(parse(doc).error?.issues ?? []).toEqual([]);
  });

  it('with evidence below the minimum sample', () => {
    const doc = buildExplanation(inputOf('BUY', { evidence: INSUFFICIENT }));
    expect(parse(doc).error?.issues ?? []).toEqual([]);
    expect(evidenceSchema.safeParse(doc.evidence).success).toBe(true);
  });

  it('the headline, the quality and the levels follow what the schema checks against the signal', () => {
    const doc = buildExplanation(inputOf('BUY'));
    const draft = {
      ...signalDraft(),
      generatedAt: new Date(DECIDED_AT).toISOString(),
      sourceAt: new Date(DECIDED_AT).toISOString(),
      entry: doc.levels.entry,
      maxValidEntry: doc.levels.maxValidEntry,
      stopLoss: doc.levels.stop,
      tp1: doc.levels.tp1,
      tp2: doc.levels.tp2,
      riskDistance: doc.levels.riskUsd,
      entryValidUntil: new Date(DECIDED_AT + 180_000).toISOString(),
      timeStopAt: new Date(DECIDED_AT + 7_200_000).toISOString(),
      qualityScore: doc.quality.score,
      explanation: doc,
    };
    expect(signalDraftSchema.safeParse(draft).error?.issues ?? []).toEqual([]);
  });
});

describe('the stored explanation can be read by the messages', () => {
  const ref = (side: Side): SignalRef => {
    const plan = planFor(side);
    return {
      id: SIGNAL_ID,
      seq: 42,
      side,
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
  };

  it.each(['BUY', 'SELL'] as const)('%s: JSON in, message out, in both languages', (side) => {
    const stored: Explanation = explanationSchema.parse(
      JSON.parse(JSON.stringify(buildExplanation(inputOf(side)))),
    );
    for (const locale of ['en', 'hinglish'] as const) {
      const message = renderSignalNew(
        { signal: ref(side), explanation: stored },
        { locale, displayTz: 'Asia/Kolkata' },
      );
      expect(message.level).toBe(0);
      expect(message.text.startsWith('<b>FORWARD-TEST (paper)</b>')).toBe(true);
      expect(message.text).toContain(`<b>${side} XAUUSD</b>  #S-0042`);
      expect(message.text).toContain('<i>Trend Pullback v0.1.0</i>');
      // what Telegram receives is valid HTML, not the plain-text fallback
      expect(checkTelegramHtml(message.text)).toBeNull();
      expect(message.text).toContain('<blockquote expandable>');
    }
  });

  it('the results that the tracker records can be written as messages', () => {
    const signal = ref('BUY');
    const options = { locale: 'en', displayTz: 'Asia/Kolkata' } as const;
    const outcome: TradeOutcome = {
      result: 'LOSS',
      countsInStats: true,
      closedAt: DECIDED_AT + 900_000,
      exitPrice: signal.stopLoss,
      exitReason: 'STOP',
      realizedRGross: -1,
      costR: 0,
      realizedRNet: -1,
      durationS: 900,
      mfeR: 0.2,
      maeR: -1,
      tp1Hit: false,
      tp2Hit: false,
      ambiguous: false,
      isWin: false,
    };
    expect(renderSignalClosed({ signal, outcome, review: null }, options).text).toContain(
      '<b>LOSS #S-0042  -1.00R net</b>',
    );
    expect(
      renderSignalTp1({ signal, at: DECIDED_AT + 60_000, price: signal.tp1 }, options).kind,
    ).toBe('SIGNAL_TP1');
    expect(renderSignalCancelled({ signal, staleSeconds: 30 }, options).kind).toBe(
      'SIGNAL_CANCELLED',
    );
    expect(
      renderFinalReview(
        {
          signal,
          review: {
            status: 'FINAL',
            primaryCause: 'NORMAL_LOSS',
            causes: [{ code: 'NORMAL_LOSS', evidence: {} }],
            weakGroupsAtEntry: [],
            counterfactual: null,
          },
          previousPrimary: null,
          trackedThisMonth: null,
        },
        options,
      ).kind,
    ).toBe('SIGNAL_REVIEW_FINAL');
  });

  it('turns flags into the warning codes of the schema', () => {
    const warnings = warningsOf([
      { flag: 'NEWS_UNKNOWN', present: true, detail: {} },
      {
        flag: 'NEAR_LEVEL',
        present: true,
        detail: { kind: 'ROUND_NUMBER', price: 4020, distanceAtr: 0.3 },
      },
    ]);
    const doc = { ...buildExplanation(inputOf('BUY')), warnings };
    expect(parse(doc).error?.issues ?? []).toEqual([]);
  });
});
