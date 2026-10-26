import {
  DecisionEngine,
  type Candidate,
  type DecisionContext,
  type EngineDecision,
  type Side,
  type TradePlan,
} from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pullbackSpec } from '../../../../packages/core/src/engine/test-data';
import type { BidBar } from '../histdata/format';
import { replay, type ReplayOptions } from './replay';
import { runBacktest } from './run';
import { DEFAULT_SPLIT } from './splits';
import { FROM, MINUTE, bar, planAt, quiet, spreadAt, wavyBars } from './test-data';
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
  it('says the news state is unknown on every signal: there is no calendar for the past', () => {
    expect(FULL.signals.length).toBeGreaterThan(0);
    for (const signal of FULL.signals) expect(signal.warnings).toContain('NEWS_UNKNOWN');
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

describe('runBacktest: the half years', () => {
  const START = Date.UTC(2025, 6, 1);
  const keysOf = (lastBarAt: number): string[] =>
    runBacktest(wavyBars(lastBarAt - 5 * MINUTE, 6), {
      specs: [pullbackSpec()],
      spreadUsd: 0.12,
    })
      .periods.map((period) => period.key)
      .filter((key) => /^\d{4}H[12]$/.test(key));

  it('has the half year of the last bar when that bar is exactly at its start', () => {
    expect(keysOf(START)).toEqual(['2025H1', '2025H2']);
  });

  it('has no half year that starts after the last bar', () => {
    expect(keysOf(START - MINUTE)).toEqual(['2025H1']);
  });
});

interface Setup {
  readonly side: Side;
  readonly key?: string;
  readonly plan?: (plan: TradePlan) => TradePlan;
}

interface Meeting {
  readonly closeTime: number;
  readonly quoteAt: number;
  readonly open: DecisionContext['open'];
  readonly calendar: DecisionContext['calendar'];
}

/**
 * Replay with the answer of the engine put in by hand: `setups` says which 5m closes (in minutes after FROM)
 * have a setup and what it is. What replay does around the engine (the quote it finds, the trades it says are
 * open, the signals it keeps) is the real code, and `meetings` is what the engine was told at each decision.
 */
function drive(
  bars: readonly BidBar[],
  setups: Readonly<Record<number, readonly Setup[]>>,
  change: Partial<ReplayOptions> = {},
) {
  const pushed = vi.spyOn(DecisionEngine.prototype, 'push');
  const closeTime = (): number =>
    (pushed.mock.calls.filter(([tf]) => tf === '5m').at(-1)?.[1].openTime ?? 0) + 5 * MINUTE;
  const setupsNow = (): readonly Setup[] => setups[(closeTime() - FROM) / MINUTE] ?? [];
  vi.spyOn(DecisionEngine.prototype, 'candidates').mockImplementation(() =>
    setupsNow().map(() => ({}) as Candidate),
  );
  const meetings: Meeting[] = [];
  vi.spyOn(DecisionEngine.prototype, 'decide').mockImplementation((context) => {
    const decidedAt = closeTime();
    meetings.push({
      closeTime: decidedAt,
      quoteAt: context.quote.t,
      open: context.open,
      calendar: context.calendar,
    });
    return {
      report: { decidedAt },
      outcomes: setupsNow().map(({ side, key = 'leg-1', plan }) => ({
        kind: 'SIGNAL',
        draft: {
          strategyKey: 'trend_pullback',
          strategyVersion: '0.1.0',
          side,
          setupKey: key,
          qualityScore: 70,
          regime: 'TREND_UP',
          session: 'LONDON',
          warnings: [],
        },
        plan: (plan ?? ((own: TradePlan) => own))(planAt(side, decidedAt)),
      })),
    } as unknown as EngineDecision;
  });
  const result = replay(bars, { specs: [pullbackSpec()], spreadAt, ...change });
  return { result, meetings };
}

describe('replay: what it keeps and tells around the engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BUY: Setup = { side: 'BUY' };
  const SELL: Setup = { side: 'SELL' };
  const longer = (entryValidSec: number) =>
    pullbackSpec({ risk: { ...pullbackSpec().risk, entryValidSec } });

  it('decides on a bar exactly as late after the close as the entry validity, and not on a later one', () => {
    const atLimit = drive([...quiet(0, 10, 1000), ...quiet(13, 30, 1000)], { 10: [BUY] });
    expect(atLimit.result.noQuote).toBe(0);
    expect(atLimit.meetings.map((meeting) => meeting.quoteAt)).toEqual([FROM + 13 * MINUTE]);
    const past = drive([...quiet(0, 10, 1000), ...quiet(14, 30, 1000)], { 10: [BUY] });
    expect(past.result.noQuote).toBe(1);
    expect(past.meetings).toEqual([]);
  });

  it('takes the shortest entry validity of the strategies', () => {
    const bars = [...quiet(0, 10, 1000), ...quiet(14, 30, 1000)];
    const mixed = drive(bars, { 10: [BUY] }, { specs: [longer(600), pullbackSpec()] });
    expect(mixed.result.noQuote).toBe(1);
    expect(mixed.meetings).toEqual([]);
    const long = drive(bars, { 10: [BUY] }, { specs: [longer(600)] });
    expect(long.result.noQuote).toBe(0);
    expect(long.meetings).toHaveLength(1);
  });

  it('tells the engine the calendar is not there, as the past has none', () => {
    const { meetings } = drive(quiet(0, 20, 1000), { 10: [BUY] });
    expect(meetings.map((meeting) => meeting.calendar)).toEqual([{ available: false, events: [] }]);
  });

  it('makes a signal for the BUY and for the SELL of one setup of one strategy, and one only for each', () => {
    const { result } = drive(quiet(0, 40, 1000), {
      10: [BUY, SELL],
      15: [BUY],
      20: [SELL],
    });
    expect(result.signals.map((signal) => signal.side)).toEqual(['BUY', 'SELL']);
    expect(result.duplicates).toBe(2);
  });

  it('keeps a trade that is not finished open for every later decision', () => {
    const { meetings } = drive(quiet(0, 40, 1000), { 10: [BUY], 20: [SELL] });
    expect(meetings.map((meeting) => meeting.open)).toEqual([
      [],
      [{ id: 'bt:0', side: 'BUY', riskR: 1 }],
    ]);
  });

  it('takes a trade out of the open ones at the close it closed on, and not before', () => {
    const stoppedAt = (minute: number) => [
      ...quiet(0, minute, 1000),
      bar(minute, 1000, 1000.1, 995, 996),
      ...quiet(minute + 1, 20, 996),
    ];
    const onClose = drive(stoppedAt(20), { 10: [BUY], 20: [SELL] });
    expect(onClose.meetings.map((meeting) => meeting.open)).toEqual([[], []]);
    const after = drive(stoppedAt(21), { 10: [BUY], 20: [SELL] });
    expect(after.meetings.map((meeting) => meeting.open)).toEqual([
      [],
      [{ id: 'bt:0', side: 'BUY', riskR: 1 }],
    ]);
  });

  it('counts a trade as open by what it did in scenario A, the one without slippage or delay', () => {
    const narrow = {
      side: 'BUY',
      plan: (plan) => ({ ...plan, maxValidEntry: plan.entry + 0.1 }),
    } satisfies Setup;
    const bars = [
      ...quiet(0, 10, 1000),
      bar(10, 1000, 1001, 999.9, 1000),
      ...quiet(11, 14, 1000),
      bar(25, 1000, 1000.1, 995, 996),
      ...quiet(26, 10, 996),
    ];
    const { result, meetings } = drive(bars, { 10: [narrow], 20: [SELL] });
    const [buy] = result.signals;
    const skipped = { kind: 'SKIPPED', reason: 'BEYOND_MAX_VALID_ENTRY' };
    expect(buy?.results.A.kind).toBe('CLOSED');
    expect(buy?.results.B).toEqual(skipped);
    expect(buy?.results.C).toEqual(skipped);
    expect(meetings.map((meeting) => meeting.open)).toEqual([
      [],
      [{ id: 'bt:0', side: 'BUY', riskR: 1 }],
    ]);
  });
});
