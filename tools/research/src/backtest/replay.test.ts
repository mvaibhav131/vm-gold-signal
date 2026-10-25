import { describe, expect, it } from 'vitest';

import { pullbackSpec } from '../../../../packages/core/src/engine/test-data';
import { replay } from './replay';
import { runBacktest } from './run';
import { DEFAULT_SPLIT } from './splits';
import { FROM, MINUTE, spreadAt, wavyBars } from './test-data';
import { SCENARIO_KEYS, type BacktestSignal } from './types';

const options = { specs: [pullbackSpec()], spreadAt };
const BARS = wavyBars();
const FULL = replay(BARS, options);

/** What a decision is made of, without the trades that came after it. */
const decisionOf = (signal: BacktestSignal) => ({
  id: signal.id,
  strategyKey: signal.strategyKey,
  side: signal.side,
  setupKey: signal.setupKey,
  decidedAt: signal.decidedAt,
  qualityScore: signal.qualityScore,
  regime: signal.regime,
  session: signal.session,
  warnings: signal.warnings,
  plan: signal.plan,
});

describe('replay: the history through the engine', () => {
  it('finds signals in a market with pullbacks, each with a trade under every scenario', () => {
    expect(FULL.signals.length).toBeGreaterThanOrEqual(5);
    expect(FULL.closes).toBeGreaterThan(800);
    expect(FULL.bars).toBe(BARS.length);
    for (const signal of FULL.signals) {
      expect(Object.keys(signal.results)).toEqual([...SCENARIO_KEYS]);
      expect(signal.plan.decidedAt).toBe(signal.decidedAt);
    }
    expect(FULL.decisions).toBeLessThanOrEqual(FULL.setups);
    expect(FULL.rejectedSetups + FULL.signals.length + FULL.duplicates).toBeGreaterThanOrEqual(
      FULL.decisions,
    );
  });

  it('gives the same run every time (it is deterministic)', () => {
    const again = replay(wavyBars(), options);
    expect(JSON.stringify(again)).toBe(JSON.stringify(FULL));
  });

  it('makes one signal for a setup, strategy and side: the next candle of the same leg is a duplicate', () => {
    const keys = FULL.signals.map((s) => `${s.strategyKey}|${s.side}|${s.setupKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(FULL.duplicates).toBeGreaterThanOrEqual(1);
  });

  it('reads the signal times as the closes of 5m candles, and decides after them: never before the quote', () => {
    for (const signal of FULL.signals) {
      expect(signal.decidedAt % (5 * MINUTE)).toBe(0);
      expect(signal.decidedAt).toBeGreaterThan(FROM);
    }
  });

  /** The number of bars up to a little after the decision of the signal at `index`. */
  const barsAfter = (index: number, extra: number): number => {
    const at = FULL.signals[index]?.decidedAt ?? 0;
    return BARS.findIndex((bar) => bar.ts >= at) + extra;
  };

  it('does not look ahead: a run on a shorter history makes the same decisions before its end', () => {
    for (const index of [1, 3, FULL.signals.length - 1]) {
      const cut = barsAfter(index, 5);
      const short = replay(BARS.slice(0, cut), options);
      const end = BARS[cut - 1]?.ts ?? 0;
      const before = (list: readonly BacktestSignal[]) =>
        list.filter((signal) => signal.decidedAt <= end).map(decisionOf);
      expect(before(short.signals)).toEqual(before(FULL.signals));
      expect(before(short.signals).length).toBeGreaterThanOrEqual(index + 1);
    }
  });

  it('gives the trades that closed before the end of a shorter history the same results', () => {
    const cut = barsAfter(FULL.signals.length - 1, 400);
    const short = replay(BARS.slice(0, cut), options);
    const end = BARS[cut - 1]?.ts ?? 0;
    let compared = 0;
    for (const signal of short.signals) {
      const result = signal.results.A;
      if (result.kind !== 'CLOSED' || result.outcome.closedAt > end) continue;
      const full = FULL.signals.find((candidate) => candidate.id === signal.id);
      expect(full?.results.A).toEqual(result);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });
  it('counts a setup with no bar to decide on', () => {
    // the bars stop right after the last close of the data: the first quote of the last close is missing
    const last = BARS.at(-1)?.ts ?? 0;
    const closeAt = Math.floor(last / (5 * MINUTE)) * 5 * MINUTE;
    const shortened = BARS.filter((bar) => bar.ts < closeAt || bar.ts > closeAt + 10 * MINUTE);
    const result = replay(shortened, options);
    expect(result.noQuote + result.decisions).toBeGreaterThanOrEqual(result.decisions);
  });

  it('can start the history after a hole: bars from a later time give a result too', () => {
    const later = BARS.slice(1_500);
    const result = replay(later, options);
    expect(result.firstAt).toBe(later[0]?.ts);
    expect(result.lastAt).toBe(later.at(-1)?.ts);
  });

  it('has no bars to read and nothing to say for an empty history', () => {
    expect(replay([], options)).toMatchObject({
      signals: [],
      bars: 0,
      closes: 0,
      firstAt: null,
      lastAt: null,
    });
  });
});

describe('replay: the holdout guard', () => {
  // the bars cross midnight of the first of January 2026, where the test period starts
  const START = DEFAULT_SPLIT.TEST.from - 2 * 24 * 60 * MINUTE;
  const crossing = wavyBars(START, 4_300);

  it('reads no bar from the start of the test period on, when it is told not to', () => {
    const guarded = replay(crossing, { ...options, until: DEFAULT_SPLIT.TEST.from });
    expect(guarded.lastAt).toBeLessThan(DEFAULT_SPLIT.TEST.from);
    expect(guarded.bars).toBeLessThan(crossing.length);
    expect(guarded.bars).toBe(crossing.filter((bar) => bar.ts < DEFAULT_SPLIT.TEST.from).length);
  });

  it('runBacktest reads nothing after the period it goes through: tuning reads no bar of the validation either', () => {
    const closedRun = runBacktest(crossing, { specs: [pullbackSpec()], spreadUsd: 0.12 });
    expect(closedRun.replay.lastAt).toBeLessThan(DEFAULT_SPLIT.TEST.from);
    expect(closedRun.periods.map((period) => period.key)).not.toContain('TEST');
    expect(closedRun.gate.period).toBe('VALIDATION');

    const open = runBacktest(crossing, {
      specs: [pullbackSpec()],
      spreadUsd: 0.12,
      through: 'TEST',
    });
    expect(open.replay.lastAt).toBe(crossing.at(-1)?.ts);
    expect(open.periods.map((period) => period.key)).toContain('TEST');
    expect(open.gate.period).toBe('TEST');
  });

  it('puts no signal of the test period in a run that did not read it', () => {
    const closedRun = runBacktest(crossing, { specs: [pullbackSpec()], spreadUsd: 0.12 });
    for (const signal of closedRun.replay.signals) {
      expect(signal.decidedAt).toBeLessThan(DEFAULT_SPLIT.TEST.from);
    }
  });
});
