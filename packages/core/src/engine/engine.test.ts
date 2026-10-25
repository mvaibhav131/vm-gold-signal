import { describe, expect, it, vi } from 'vitest';

import { GATE_CODES } from '../domain';
import { mergeByClose } from './feed';
import { DecisionEngine } from './engine';
import {
  BASE,
  EVIDENCE,
  FIVE_MS,
  contextOf,
  decideNow,
  engineAt,
  mirrored,
  pullbackSpec,
  seriesOf,
  shifted,
} from './test-data';
import type { Outcome } from './types';

const TRIGGER = 53;

function only(outcomes: readonly Outcome[]): Outcome {
  expect(outcomes).toHaveLength(1);
  const [outcome] = outcomes;
  if (outcome === undefined) throw new Error('no outcome');
  return outcome;
}

function signalOf(outcomes: readonly Outcome[]) {
  const outcome = only(outcomes);
  if (outcome.kind !== 'SIGNAL') {
    throw new Error(`expected a signal, got ${JSON.stringify(outcome.rejection)}`);
  }
  return outcome.draft;
}

function rejectionOf(outcomes: readonly Outcome[]) {
  const outcome = only(outcomes);
  if (outcome.kind !== 'REJECTED') throw new Error('expected a rejection');
  return outcome.rejection;
}

const base = () => engineAt(BASE, [pullbackSpec()], TRIGGER);

describe('mergeByClose', () => {
  it('orders candles by the instant they close, the 1h first, then the 15m, then the 5m', () => {
    const steps = mergeByClose(seriesOf(BASE));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]?.closeTime ?? 0).toBeGreaterThanOrEqual(steps[i - 1]?.closeTime ?? 0);
    }
    const close = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const together = steps.filter((step) => step.closeTime === close).map((step) => step.tf);
    expect(together).toEqual(['1h', '15m', '5m']);
    expect(steps).toHaveLength(BASE.hourly.length + BASE.quarter.length + BASE.five.length);
  });

  it('puts a 5m candle before the 15m candle that closes later', () => {
    const steps = mergeByClose(seriesOf(BASE));
    const fives = steps.filter((step) => step.tf === '5m').map((step) => step.closeTime);
    expect(fives).toEqual([...fives].sort((a, b) => a - b));
  });
});

describe('DecisionEngine: a signal', () => {
  it('makes a BUY of the pullback on the first quote after the close', () => {
    const engine = base();
    const view = engine.view();
    const decidedAt = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const draft = signalOf(decideNow(engine).outcomes);

    expect(view?.openTime).toBe(BASE.five[TRIGGER]?.openTime);
    expect(draft).toMatchObject({
      symbol: 'XAUUSD',
      side: 'BUY',
      strategyKey: 'trend_pullback',
      strategyVersion: '0.1.0',
      exitProfile: 'EP1_PARTIAL',
      mode: 'LIVE',
      generatedAt: new Date(decidedAt).toISOString(),
      sourceAt: new Date(decidedAt).toISOString(),
      entryValidUntil: new Date(decidedAt + 180_000).toISOString(),
      timeStopAt: new Date(decidedAt + 7_200_000).toISOString(),
      regime: 'UNCERTAIN',
      session: 'OVERLAP',
      volBucket: 'NORMAL',
      newsState: 'CLEAR',
      openSignalsAtEntry: 0,
      dataLatencyMs: 1_000,
    });
    // the fill is the ask of the confirming quote plus the 0.05 slippage; R is its distance to the stop
    const close = view?.close ?? 0;
    expect(draft.entry).toBeCloseTo(close + 0.06 + 0.05, 3);
    expect(draft.riskDistance).toBeCloseTo(draft.entry - draft.stopLoss, 3);
    expect(draft.tp1).toBeCloseTo(draft.entry + draft.riskDistance, 3);
    expect(draft.tp2).toBeCloseTo(draft.entry + 2 * draft.riskDistance, 3);
    expect(draft.maxValidEntry).toBeGreaterThan(draft.entry);
    expect(draft.atr5).toBeCloseTo(view?.atr5 ?? 0, 3);
    expect(draft.setupKey).toMatch(/^trend_pullback:5m:leg-2026-01-06T\d\d:\d\d:00Z$/);
  });

  it('records every gate once, all passed, and every quality group once', () => {
    const draft = signalOf(decideNow(base()).outcomes);
    expect(draft.hardGates.map((gate) => gate.code)).toEqual([...GATE_CODES]);
    expect(draft.hardGates.every((gate) => gate.passed)).toBe(true);
    expect(draft.groupedScores.map((group) => group.key)).toEqual([
      'trend',
      'structure',
      'trigger',
      'volatility',
      'execution',
      'sessionMacro',
      'reward',
    ]);
    expect(draft.qualityScore).toBeGreaterThanOrEqual(65);
  });

  it('has an explanation whose levels and quality are those of the signal', () => {
    const draft = signalOf(decideNow(base()).outcomes);
    const explanation = draft.explanation as {
      headline: string;
      quality: { score: number; grade: string };
      levels: Record<string, number | null>;
      open: { count: number; riskR: number };
      evidence: unknown;
    };
    expect(explanation.headline).toBe('BUY XAUUSD - Trend Pullback v0.1.0');
    expect(explanation.quality.score).toBe(draft.qualityScore);
    expect(explanation.levels).toEqual({
      entry: draft.entry,
      maxValidEntry: draft.maxValidEntry,
      stop: draft.stopLoss,
      tp1: draft.tp1,
      tp2: draft.tp2,
      riskUsd: draft.riskDistance,
    });
    expect(explanation.open).toEqual({ count: 0, riskR: 0 });
    expect(explanation.evidence).toEqual(EVIDENCE);
    expect(draft.evidence).toEqual(EVIDENCE);
  });

  it('keeps the numbers behind the decision, with the spread of the quote under `spread`', () => {
    const draft = signalOf(decideNow(base()).outcomes);
    expect(draft.featureSnapshot.spread).toBe(0.12);
    expect(typeof draft.featureSnapshot.state5).toBe('string');
    expect(draft.featureSnapshot.atr5).toBeCloseTo(draft.atr5, 3);
  });

  it('is a SELL, with the levels of the BUY upside down, on the mirrored market', () => {
    const buy = signalOf(decideNow(base()).outcomes);
    const sellEngine = engineAt(mirrored(BASE), [pullbackSpec()], TRIGGER);
    const sell = signalOf(decideNow(sellEngine).outcomes);
    expect(sell.side).toBe('SELL');
    expect(sell.entry).toBeCloseTo(8000 - buy.entry, 3);
    expect(sell.stopLoss).toBeCloseTo(8000 - buy.stopLoss, 3);
    expect(sell.tp1).toBeCloseTo(8000 - buy.tp1, 3);
    expect(sell.tp2).toBeCloseTo(8000 - (buy.tp2 ?? 0), 3);
    expect(sell.riskDistance).toBeCloseTo(buy.riskDistance, 3);
    expect(sell.qualityScore).toBe(buy.qualityScore);
  });

  it('gives the same answer twice, and from two engines fed the same candles', () => {
    const one = base();
    const first = decideNow(one);
    expect(decideNow(one)).toEqual(first);
    expect(decideNow(base())).toEqual(first);
  });

  it('does not change when later candles arrive: the answer for a candle is the one given at its close', () => {
    const live = new DecisionEngine([pullbackSpec()]);
    let atTrigger: ReturnType<typeof decideNow> | null = null;
    const closeOfTrigger = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    for (const step of mergeByClose(seriesOf(BASE))) {
      live.push(step.tf, step.candle);
      if (step.tf === '5m' && step.closeTime === closeOfTrigger) atTrigger = decideNow(live);
    }
    expect(atTrigger).not.toBeNull();
    expect(atTrigger).toEqual(decideNow(base()));
  });

  it('is nothing before the first 5m candle', () => {
    const engine = new DecisionEngine([pullbackSpec()]);
    expect(engine.decide(contextOf(4000), () => EVIDENCE)).toBeNull();
    expect(engine.candidates()).toEqual([]);
    expect(engine.view()).toBeNull();
  });

  it('refuses to be made without a strategy', () => {
    expect(() => new DecisionEngine([])).toThrow('at least one strategy');
  });
});

describe('DecisionEngine: the report of the market', () => {
  it('says the regime, the session, the news state and the five market gates, with or without a setup', () => {
    const engine = engineAt(BASE, [pullbackSpec()], TRIGGER - 10);
    const { report, outcomes } = decideNow(engine);
    expect(outcomes).toEqual([]);
    expect(report).toMatchObject({
      regime: null,
      volBucket: null,
      session: 'OVERLAP',
      newsState: 'CLEAR',
      candidates: 0,
    });
    expect(report.counts['5m']).toBe(44);
    expect(report.marketGates.map((gate) => gate.code)).toEqual([
      'DATA_FRESH',
      'WARMUP_OK',
      'CLOCK_OK',
      'SPREAD_OK',
      'GAP_RECOVERY_OK',
    ]);
    expect(report.marketGates.every((gate) => gate.passed)).toBe(true);
  });

  it('shows a failed market gate there, so that "WAIT: reason" has its reason when nothing is going on', () => {
    const { report } = decideNow(base(), { feed: { ...contextOf(0).feed, tickAgeMs: 30_000 } });
    expect(report.marketGates.filter((gate) => !gate.passed).map((gate) => gate.code)).toEqual([
      'DATA_FRESH',
    ]);
  });

  it('lists the candidates with the key of their evidence', () => {
    const [candidate, ...rest] = base().candidates();
    expect(rest).toEqual([]);
    expect(candidate?.dims).toEqual({
      strategyKey: 'trend_pullback',
      strategyVersion: '0.1.0',
      side: 'BUY',
      session: 'OVERLAP',
      regime: 'UNCERTAIN',
      volBucket: 'NORMAL',
    });
    expect(candidate?.sweptLevelId).toBeNull();
    expect(candidate?.structureTarget).toBeNull();
  });

  it('asks for the evidence of each candidate with that key', () => {
    const seen: unknown[] = [];
    base().decide(contextOf(4070.7), (dims) => {
      seen.push(dims);
      return EVIDENCE;
    });
    expect(seen).toEqual([
      {
        strategyKey: 'trend_pullback',
        strategyVersion: '0.1.0',
        side: 'BUY',
        session: 'OVERLAP',
        regime: 'UNCERTAIN',
        volBucket: 'NORMAL',
      },
    ]);
  });
});

describe('DecisionEngine: a rejection names what failed', () => {
  const codesOf = (change: Parameters<typeof decideNow>[1], spec = pullbackSpec()) =>
    rejectionOf(decideNow(engineAt(BASE, [spec], TRIGGER), change).outcomes);

  it('has the setup, the gates in their order, and the score', () => {
    const rejection = codesOf({ clockSkewMs: 9_000 });
    expect(rejection).toMatchObject({
      strategyKey: 'trend_pullback',
      side: 'BUY',
      codes: ['CLOCK_OK'],
    });
    expect(rejection.qualityScore).toBeGreaterThan(65);
    expect(rejection.setupKey).toMatch(/^trend_pullback:5m:leg-/);
  });

  it('is DATA_FRESH when the feed is silent, disconnected, stale at the provider or the market is closed', () => {
    const feed = contextOf(0).feed;
    expect(codesOf({ feed: { ...feed, tickAgeMs: 30_000 } }).codes).toEqual(['DATA_FRESH']);
    expect(codesOf({ feed: { ...feed, connected: false } }).codes).toEqual(['DATA_FRESH']);
    expect(codesOf({ feed: { ...feed, providerStale: true } }).codes).toEqual(['DATA_FRESH']);
    expect(codesOf({ feed: { ...feed, marketState: 'CLOSED' } }).codes).toEqual(['DATA_FRESH']);
  });

  it('is WARMUP_OK while a timeframe lacks its candles', () => {
    const spec = pullbackSpec();
    const slow = {
      ...spec,
      gates: { ...spec.gates, warmupCandles: { '5m': 900, '15m': 1, '1h': 1 } },
    };
    expect(codesOf({}, slow).codes).toEqual(['WARMUP_OK']);
  });

  it('is CLOCK_OK for a clock that is off, and when it cannot be told', () => {
    expect(codesOf({ clockSkewMs: -9_000 }).codes).toEqual(['CLOCK_OK']);
    expect(codesOf({ clockSkewMs: null }).codes).toEqual(['CLOCK_OK']);
  });

  it('is SPREAD_OK for a wide spread', () => {
    const rejection = codesOf({
      quote: { t: (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS, bid: 4070.2, ask: 4071.2 },
    });
    expect(rejection.codes).toContain('SPREAD_OK');
  });

  it('is GAP_RECOVERY_OK until there is a long enough run of clean candles', () => {
    const spec = pullbackSpec();
    const strict = { ...spec, gates: { ...spec.gates, gapRecoveryCandles: 100 } };
    expect(codesOf({}, strict).codes).toEqual(['GAP_RECOVERY_OK']);
  });

  it('is REGIME_OK for a regime that the strategy does not accept (and an unknown regime is UNCERTAIN)', () => {
    const rejection = codesOf({}, pullbackSpec({ acceptedRegimes: ['TREND_UP', 'TREND_DOWN'] }));
    expect(rejection.codes).toEqual(['REGIME_OK']);
    expect(rejection.detail).toMatchObject({ regime: 'UNCERTAIN' });
  });

  it('is STOP_OK for a stop that is too far, and TARGET_OK for a target that is too far', () => {
    const spec = pullbackSpec();
    const tight = { ...spec, gates: { ...spec.gates, stopAtr: [0.1, 1] as const } };
    expect(codesOf({}, tight).codes).toEqual(['STOP_OK']);
    const near = { ...spec, gates: { ...spec.gates, tp1MaxAtr: 1 } };
    expect(codesOf({}, near).codes).toEqual(['TARGET_OK']);
  });

  it('is QUALITY_OK for a score below the minimum, and for a score that rests on too little of the weight', () => {
    const spec = pullbackSpec();
    const picky = { ...spec, gates: { ...spec.gates, quality: { min: 99, minCoverage: 0.4 } } };
    const low = codesOf({}, picky);
    expect(low.codes).toEqual(['QUALITY_OK']);
    expect(low.qualityScore).toBeGreaterThan(0);
    const thin = { ...spec, gates: { ...spec.gates, quality: { min: 65, minCoverage: 0.99 } } };
    expect(codesOf({}, thin).codes).toEqual(['QUALITY_OK']);
  });

  it('lists several failures together, in the order of the gates', () => {
    const spec = pullbackSpec();
    const strict = {
      ...spec,
      acceptedRegimes: ['TREND_UP' as const],
      gates: { ...spec.gates, tp1MaxAtr: 1 },
    };
    const feed = { ...contextOf(0).feed, tickAgeMs: 30_000 };
    expect(codesOf({ feed, clockSkewMs: 9_000 }, strict).codes).toEqual([
      'DATA_FRESH',
      'CLOCK_OK',
      'REGIME_OK',
      'TARGET_OK',
    ]);
  });

  it('is STOP_OK, with its reason, when the quote has already gone through the stop (no trade can be planned)', () => {
    const stop = signalOf(decideNow(base()).outcomes).stopLoss;
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const rejection = codesOf({ quote: { t: at, bid: stop - 1.12, ask: stop - 1 } });
    expect(rejection.codes).toContain('STOP_OK');
    expect(rejection.detail).toMatchObject({ reason: 'STOP_NOT_BEYOND_ENTRY' });
    expect(rejection.qualityScore).toBeNull();
  });

  it('writes a rejection for every setup of the pass, and the gates of the signal that was made are all passed', () => {
    const { outcomes } = decideNow(base());
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['SIGNAL']);
  });
});

describe('DecisionEngine: the advisory flags', () => {
  const warnings = (change: Parameters<typeof decideNow>[1], spec = pullbackSpec()) =>
    signalOf(decideNow(engineAt(BASE, [spec], TRIGGER), change).outcomes).warnings;

  it('warns about a strategy that is not validated, and about nothing else on a calm day', () => {
    expect(warnings({})).toEqual(['UNVALIDATED_STRATEGY']);
    expect(warnings({}, pullbackSpec({ status: 'VALIDATED' }))).toEqual([]);
  });

  it('shows the warnings in the explanation, with their words', () => {
    const draft = signalOf(decideNow(base()).outcomes);
    const explanation = draft.explanation as { warnings: { code: string; text: string }[] };
    expect(explanation.warnings.map((warning) => warning.code)).toEqual(['UNVALIDATED_STRATEGY']);
  });

  it('warns that the news is unknown when the calendar feed is down, and never calls it clear', () => {
    const draft = signalOf(
      decideNow(base(), { calendar: { available: false, events: [] } }).outcomes,
    );
    expect(draft.warnings).toContain('NEWS_UNKNOWN');
    expect(draft.newsState).toBe('UNKNOWN');
  });

  it('is in the news window 30 minutes before a high-impact USD event, and says which event', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const calendar = {
      available: true,
      events: [
        { id: 'cpi', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'USD' },
      ],
      names: { cpi: 'CPI m/m' },
    };
    const draft = signalOf(decideNow(base(), { calendar }).outcomes);
    expect(draft.newsState).toBe('IN_WINDOW');
    expect(draft.warnings).toContain('NEWS_WINDOW');
    const explanation = draft.explanation as {
      macro: { state: string; next: { name: string } | null };
      warnings: { code: string; text: string }[];
    };
    expect(explanation.macro).toMatchObject({ state: 'IN_WINDOW', next: { name: 'CPI m/m' } });
    expect(explanation.warnings.find((warning) => warning.code === 'NEWS_WINDOW')?.text).toContain(
      'CPI m/m',
    );
  });

  it('ignores an event of another currency or a lower impact', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const events = [
      { id: 'a', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'EUR' },
      { id: 'b', scheduledAt: at + 30 * 60_000, importance: 'low' as const, currency: 'USD' },
    ];
    expect(
      signalOf(decideNow(base(), { calendar: { available: true, events } }).outcomes).newsState,
    ).toBe('CLEAR');
  });

  it('blocks on the news window when the owner switched it to block, and says so', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const calendar = {
      available: true,
      events: [
        { id: 'cpi', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'USD' },
      ],
    };
    const rejection = rejectionOf(
      decideNow(base(), { calendar, modes: { newsWindow: 'block' } }).outcomes,
    );
    expect(rejection.codes).toEqual(['NEWS_WINDOW']);
    expect(rejection.detail).toMatchObject({ blockedBy: ['NEWS_WINDOW'] });
  });

  it('uses the mode of the strategy config when the owner has no switch', () => {
    const spec = pullbackSpec();
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const calendar = {
      available: true,
      events: [
        { id: 'cpi', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'USD' },
      ],
    };
    const blocking = { ...spec, modes: { ...spec.modes, newsWindow: 'block' as const } };
    expect(
      rejectionOf(decideNow(engineAt(BASE, [blocking], TRIGGER), { calendar }).outcomes).codes,
    ).toEqual(['NEWS_WINDOW']);
    expect(
      signalOf(
        decideNow(engineAt(BASE, [blocking], TRIGGER), { calendar, modes: { newsWindow: 'warn' } })
          .outcomes,
      ).warnings,
    ).toContain('NEWS_WINDOW');
  });

  it('warns of a high-impact headline in the last 30 minutes, and not of an older one', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const recent = {
      feed: 'AVAILABLE' as const,
      headlines: [],
      lastHighHeadlineAt: at - 10 * 60_000,
    };
    const old = { feed: 'AVAILABLE' as const, headlines: [], lastHighHeadlineAt: at - 40 * 60_000 };
    expect(warnings({ news: recent })).toContain('HEADLINE_RECENT');
    expect(warnings({ news: old })).not.toContain('HEADLINE_RECENT');
  });

  it('warns that it opposes an open signal, names it, and counts the open risk', () => {
    const open = [
      { id: 'sell-1', side: 'SELL' as const, riskR: 1 },
      { id: 'buy-1', side: 'BUY' as const, riskR: 0 },
    ];
    const draft = signalOf(
      decideNow(base(), { open, openLabels: { 'sell-1': '#S-0041' } }).outcomes,
    );
    expect(draft.warnings).toContain('OPPOSES_OPEN');
    expect(draft.openSignalsAtEntry).toBe(2);
    const explanation = draft.explanation as {
      open: { count: number; riskR: number };
      warnings: { code: string; text: string }[];
    };
    expect(explanation.open).toEqual({ count: 2, riskR: 1 });
    expect(explanation.warnings.find((warning) => warning.code === 'OPPOSES_OPEN')?.text).toContain(
      '#S-0041',
    );
  });

  it('does not warn of open signals that go the same way', () => {
    const open = [{ id: 'buy-1', side: 'BUY' as const, riskR: 1 }];
    expect(warnings({ open })).not.toContain('OPPOSES_OPEN');
  });

  it('marks a replay signal with its mode', () => {
    expect(signalOf(decideNow(base(), { mode: 'BACKTEST' }).outcomes).mode).toBe('BACKTEST');
    expect(signalOf(decideNow(base(), { mode: 'SIMULATED' }).outcomes).mode).toBe('SIMULATED');
  });

  it('is in the news window of the events of every time zone: a later day is not', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const events = [
      {
        id: 'later',
        scheduledAt: at + 5 * 3_600_000,
        importance: 'high' as const,
        currency: 'USD',
      },
    ];
    const draft = signalOf(decideNow(base(), { calendar: { available: true, events } }).outcomes);
    expect(draft.newsState).toBe('CLEAR');
    const explanation = draft.explanation as { macro: { next: { name: string } | null } };
    expect(explanation.macro.next?.name).toBe('High-impact event');
  });
});

describe('DecisionEngine: more than one strategy', () => {
  it('runs every strategy on the same candles and reports only the ones that have a setup', () => {
    const specs = [pullbackSpec()];
    const engine = engineAt(BASE, specs, TRIGGER);
    expect(engine.specs).toBe(specs);
    expect(engine.candidates().map((candidate) => candidate.spec.strategyKey)).toEqual([
      'trend_pullback',
    ]);
  });

  it('shifts the whole market in time without changing a decision (only the session)', () => {
    const later = engineAt(shifted(BASE, 24), [pullbackSpec()], TRIGGER);
    const a = signalOf(decideNow(base()).outcomes);
    const b = signalOf(decideNow(later).outcomes);
    expect(b.entry).toBe(a.entry);
    expect(b.qualityScore).toBe(a.qualityScore);
  });
});

describe('DecisionEngine: what the decision says of itself', () => {
  const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
  const cpi = (minutes: number) => ({
    available: true,
    events: [
      {
        id: 'cpi',
        scheduledAt: at + minutes * 60_000,
        importance: 'high' as const,
        currency: 'USD',
      },
    ],
    names: { cpi: 'CPI m/m' },
  });

  it('counts the setups it found, and none when the market has none', () => {
    expect(decideNow(base()).report.candidates).toBe(1);
    expect(decideNow(engineAt(BASE, [pullbackSpec()], TRIGGER - 6)).report.candidates).toBe(0);
  });

  it('says the news state of the market, with or without a setup: in the window, clear, or unknown', () => {
    const quiet = () => engineAt(BASE, [pullbackSpec()], TRIGGER - 6);
    // the quiet market is decided 30 minutes before the one with a setup: its event comes `minutes` after its own decision
    const before = (minutes: number) => cpi(minutes - 30);
    expect(decideNow(quiet(), { calendar: before(30) }).report.newsState).toBe('IN_WINDOW');
    expect(decideNow(quiet(), { calendar: before(300) }).report.newsState).toBe('CLEAR');
    expect(
      decideNow(quiet(), { calendar: { available: false, events: [] } }).report.newsState,
    ).toBe('UNKNOWN');
  });

  it('writes the time of the confirming quote as the source of the signal, and the close as its decision', () => {
    const engine = base();
    const view = engine.view();
    const quote = contextOf(view?.close ?? 0).quote;
    const draft = signalOf(decideNow(engine, { quote: { ...quote, t: at + 3_000 } }).outcomes);
    expect(draft.sourceAt).toBe(new Date(at + 3_000).toISOString());
    expect(draft.generatedAt).toBe(new Date(at).toISOString());
  });

  it('rounds the ATR of the signal to three decimals, as the contract needs', () => {
    const engine = base();
    const atr = engine.view()?.atr5 ?? 0;
    const draft = signalOf(decideNow(engine).outcomes);
    expect(Math.round(atr * 1000) / 1000).not.toBe(atr);
    expect(draft.atr5).toBe(Math.round(atr * 1000) / 1000);
  });

  it('gives the time of the next event in the explanation, and not the time of the decision', () => {
    const draft = signalOf(decideNow(base(), { calendar: cpi(30) }).outcomes);
    const explanation = draft.explanation as { macro: { next: { name: string; at: string } } };
    expect(explanation.macro.next).toEqual({
      name: 'CPI m/m',
      at: new Date(at + 30 * 60_000).toISOString(),
    });
  });

  it('judges the target by the distance to TP1, not by the distance from the stop to it', () => {
    const engine = base();
    const draft = signalOf(decideNow(engine).outcomes);
    const tp1Atr = draft.riskDistance / (engine.view()?.atr5 ?? 1);
    const spec = pullbackSpec();
    const roomy = { ...spec, gates: { ...spec.gates, tp1MaxAtr: tp1Atr * 1.5 } };
    expect(signalOf(decideNow(engineAt(BASE, [roomy], TRIGGER)).outcomes).tp1).toBe(draft.tp1);
  });

  it('puts the session of the close on the candidate and on the signal when a session opens with the candle', () => {
    // 13:00 UTC in winter: New York opens as the candle closes
    const early = engineAt(shifted(BASE, -1), [pullbackSpec()], TRIGGER);
    expect(early.candidates()[0]?.dims.session).toBe('OVERLAP');
    expect(signalOf(decideNow(early).outcomes).session).toBe('OVERLAP');
    expect(decideNow(early).report.session).toBe('OVERLAP');
  });
});

describe('DecisionEngine: more than one setup in a pass', () => {
  const two = () => [pullbackSpec(), pullbackSpec({ version: '0.2.0' })];

  it('counts the signal made first as open for the next one, with its one R', () => {
    const { outcomes, report } = decideNow(engineAt(BASE, two(), TRIGGER));
    expect(report.candidates).toBe(2);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['SIGNAL', 'SIGNAL']);
    const [first, second] = outcomes.map((outcome) => {
      if (outcome.kind !== 'SIGNAL') throw new Error('expected a signal');
      return outcome.draft;
    });
    expect(first?.openSignalsAtEntry).toBe(0);
    expect(second?.openSignalsAtEntry).toBe(1);
    expect((second?.explanation as { open: unknown }).open).toEqual({ count: 1, riskR: 1 });
  });

  it('adds the risk of the open signals of the database to the one made in the pass', () => {
    const open = [{ id: 'old', side: 'BUY' as const, riskR: 0 }];
    const { outcomes } = decideNow(engineAt(BASE, two(), TRIGGER), { open });
    const drafts = outcomes.map((outcome) => {
      if (outcome.kind !== 'SIGNAL') throw new Error('expected a signal');
      return outcome.draft;
    });
    expect(drafts.map((draft) => draft.openSignalsAtEntry)).toEqual([1, 2]);
    expect((drafts[1]?.explanation as { open: unknown }).open).toEqual({ count: 2, riskR: 1 });
  });

  it('does not count a setup that was rejected as open', () => {
    const spec = pullbackSpec();
    const strict = {
      ...pullbackSpec({ version: '0.2.0' }),
      gates: { ...spec.gates, quality: { min: 99, minCoverage: 0.4 } },
    };
    const { outcomes } = decideNow(engineAt(BASE, [strict, spec], TRIGGER));
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['REJECTED', 'SIGNAL']);
    const signal = outcomes[1];
    expect(signal?.kind === 'SIGNAL' ? signal.draft.openSignalsAtEntry : -1).toBe(0);
  });
});

describe('DecisionEngine: a market the engine cannot plan in', () => {
  /** The same engine, whose view of the market has been changed after the strategies saw it. */
  function seen(change: Record<string, unknown>) {
    const engine = base();
    const real = engine.market.view.bind(engine.market);
    vi.spyOn(engine.market, 'view').mockImplementation(() => {
      const view = real();
      return view === null ? null : { ...view, ...change };
    });
    return engine;
  }

  it.each([null, 0])('rejects a setup with STOP_OK when the ATR(5m) is %s', (atr5) => {
    const rejection = rejectionOf(decideNow(seen({ atr5 })).outcomes);
    expect(rejection).toMatchObject({
      codes: ['STOP_OK'],
      qualityScore: null,
      detail: { reason: 'NO_ATR' },
    });
  });

  it('keeps the failed market gates in front of STOP_OK when there is no ATR', () => {
    const feed = { ...contextOf(0).feed, tickAgeMs: 30_000 };
    const rejection = rejectionOf(decideNow(seen({ atr5: null }), { feed }).outcomes);
    expect(rejection.codes).toEqual(['DATA_FRESH', 'STOP_OK']);
  });

  it('raises NEWS_SHOCK in the news window when ATR(5m) is 2.5 times its median, and not at 2.4', () => {
    const atr = base().view()?.atr5 ?? 1;
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const calendar = {
      available: true,
      events: [
        { id: 'e', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'USD' },
      ],
    };
    const warnings = (ratio: number, inWindow = true) =>
      signalOf(
        decideNow(seen({ atrBaseline: atr / ratio }), {
          calendar: inWindow ? calendar : { available: true, events: [] },
        }).outcomes,
      ).warnings;
    expect(warnings(2.5)).toContain('NEWS_SHOCK');
    expect(warnings(2.4)).not.toContain('NEWS_SHOCK');
    expect(warnings(2.5, false)).not.toContain('NEWS_SHOCK');
  });

  it('raises NEWS_SHOCK in the news window when the spread is 3 times its median, and not at 2.9', () => {
    const at = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
    const calendar = {
      available: true,
      events: [
        { id: 'e', scheduledAt: at + 30 * 60_000, importance: 'high' as const, currency: 'USD' },
      ],
    };
    // the quote has a spread of 0.12
    const warnings = (ratio: number) =>
      signalOf(decideNow(seen({ spreadBaseline: 0.12 / ratio }), { calendar }).outcomes).warnings;
    expect(warnings(3)).toContain('NEWS_SHOCK');
    expect(warnings(2.9)).not.toContain('NEWS_SHOCK');
  });
});
