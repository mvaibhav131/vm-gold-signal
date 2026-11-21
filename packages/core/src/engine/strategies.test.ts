import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StrategyKey } from '../domain';
import { QUARTER_MS, fromCloses, hourlyUp, random, walk } from '../regime/test-data';
import type { StructureCandle } from '../structure/types';
import type { LiquidityLevel } from '../structure/sweeps';
import { DecisionEngine } from './engine';
import { mergeByClose } from './feed';
import { runnerOf } from './strategies';
import { BASE, decideNow, engineAt, otherSpecs, pullbackSpec, seriesOf } from './test-data';
import type { EngineCandle, EngineTimeframe, StrategySpec } from './types';

interface Call {
  readonly strategy: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

const spy = vi.hoisted(() => {
  const calls: { strategy: string; method: string; args: readonly unknown[] }[] = [];
  const answers = new Map<string, unknown>();
  const fake = (strategy: string, methods: readonly string[]) => {
    class Fake {
      constructor(readonly params: unknown) {
        calls.push({ strategy, method: 'new', args: [params] });
      }
    }
    for (const method of methods) {
      Object.defineProperty(Fake.prototype, method, {
        value: (...args: unknown[]): unknown => {
          calls.push({ strategy, method, args });
          return method === 'evaluate' ? (answers.get(strategy) ?? null) : undefined;
        },
      });
    }
    return Fake;
  };
  return { calls, answers, fake };
});

vi.mock('../strategies/trendPullback/tracker', () => ({
  TrendPullbackStrategy: spy.fake('trend_pullback', ['update', 'evaluate']),
}));
vi.mock('../strategies/sweepReversal/tracker', () => ({
  SweepReversalStrategy: spy.fake('sweep_reversal', ['updateQuarter', 'updateFive', 'evaluate']),
}));
vi.mock('../strategies/squeezeRetest/tracker', () => ({
  SqueezeRetestStrategy: spy.fake('squeeze_retest', ['updateQuarter', 'updateFive', 'evaluate']),
}));
vi.mock('../strategies/trendlineRetest/tracker', () => ({
  TrendlineRetestStrategy: spy.fake('trendline_retest', [
    'updateHour',
    'updateQuarter',
    'updateFive',
    'evaluate',
  ]),
}));
vi.mock('../strategies/patternBreakout/tracker', () => ({
  PatternBreakoutStrategy: spy.fake('pattern_breakout', [
    'updateQuarter',
    'updateFive',
    'evaluate',
  ]),
}));
vi.mock('../strategies/hourlyTrend/tracker', () => ({
  HourlyTrendStrategy: spy.fake('hourly_trend', ['update', 'evaluate']),
}));
vi.mock('../strategies/confluence/tracker', () => ({
  ConfluenceStrategy: spy.fake('confluence', ['update', 'evaluate']),
}));

const KEYS: readonly StrategyKey[] = [
  'trend_pullback',
  'sweep_reversal',
  'squeeze_retest',
  'trendline_retest',
  'pattern_breakout',
  'hourly_trend',
  'confluence',
];

/** The runner reads the key and the parameters of a spec and nothing else. */
function specOf(strategyKey: StrategyKey): StrategySpec {
  return { strategyKey, params: { key: strategyKey } } as unknown as StrategySpec;
}

const CANDLE: EngineCandle = {
  openTime: 1_700_000_000_000,
  o: 1,
  h: 2,
  l: 0.5,
  c: 1.5,
  spread: 0.1,
};
const LEVELS: readonly LiquidityLevel[] = [];

/** What each strategy is fed on each timeframe: the method and its arguments. */
const ROUTES: Readonly<Record<StrategyKey, Readonly<Record<EngineTimeframe, string | null>>>> = {
  trend_pullback: { '5m': 'update', '15m': 'update', '1h': 'update' },
  sweep_reversal: { '5m': 'updateFive', '15m': 'updateQuarter', '1h': null },
  squeeze_retest: { '5m': 'updateFive', '15m': 'updateQuarter', '1h': null },
  trendline_retest: { '5m': 'updateFive', '15m': 'updateQuarter', '1h': 'updateHour' },
  pattern_breakout: { '5m': 'updateFive', '15m': 'updateQuarter', '1h': null },
  hourly_trend: { '5m': 'update', '15m': null, '1h': 'update' },
  confluence: { '5m': 'update', '15m': 'update', '1h': 'update' },
};

const callsOf = (strategy: string, method?: string): Call[] =>
  spy.calls.filter(
    (call) =>
      call.strategy === strategy &&
      call.method !== 'new' &&
      (method === undefined || call.method === method),
  );

beforeEach(() => {
  spy.calls.length = 0;
  spy.answers.clear();
});

describe('runnerOf: the strategy is made from the parameters of its spec', () => {
  it.each(KEYS)('%s', (key) => {
    const runner = runnerOf(specOf(key));
    expect(runner.key).toBe(key);
    expect(spy.calls.filter((call) => call.method === 'new')).toEqual([
      { strategy: key, method: 'new', args: [{ key }] },
    ]);
  });
});

describe('runnerOf: every strategy reads the timeframes it needs and ignores the others', () => {
  const cases = KEYS.flatMap((key) =>
    (['5m', '15m', '1h'] as const).map((tf) => ({ key, tf, method: ROUTES[key][tf] })),
  );
  it.each(cases)('$key is fed the $tf candle through $method', ({ key, tf, method }) => {
    const runner = runnerOf(specOf(key));
    runner.push(tf, CANDLE, LEVELS);
    const made = callsOf(key);
    if (method === null) {
      expect(made).toEqual([]);
      return;
    }
    const args: unknown[] =
      key === 'trend_pullback' || key === 'hourly_trend' || key === 'confluence'
        ? [tf, CANDLE]
        : key === 'sweep_reversal' && tf === '5m'
          ? [CANDLE, LEVELS]
          : [CANDLE];
    expect(made).toEqual([{ strategy: key, method, args }]);
  });

  it('hands strategy B the liquidity levels of the 5m candle, the same list', () => {
    const levels: LiquidityLevel[] = [];
    runnerOf(specOf('sweep_reversal')).push('5m', CANDLE, levels);
    const [call] = callsOf('sweep_reversal', 'updateFive');
    expect(call?.args[1]).toBe(levels);
  });
});

describe('runnerOf: what a strategy found', () => {
  const setup = (facts: Record<string, unknown>) => ({ side: 'BUY', setupKey: 'k', facts });

  it.each(KEYS)('%s finds nothing when the strategy has no setup', (key) => {
    const runner = runnerOf(specOf(key));
    expect(runner.find(null)).toBeNull();
    spy.answers.set(key, { setup: null });
    expect(runner.find(null)).toBeNull();
  });

  it.each([
    ['trend_pullback', { depth: 1 }, null, null],
    ['squeeze_retest', { x: 1 }, null, null],
    ['trendline_retest', { y: 1 }, null, null],
    ['sweep_reversal', { levelId: 'L-7' }, 'L-7', null],
    ['pattern_breakout', { target: 4040.5 }, null, 4040.5],
    ['hourly_trend', { trend: 'UP' }, null, null],
    ['confluence', { votes: ['TREND_1H'] }, null, null],
  ] as const)(
    '%s gives the setup with its facts as the source',
    (key, facts, sweptLevelId, structureTarget) => {
      spy.answers.set(key, { setup: setup(facts) });
      expect(runnerOf(specOf(key)).find('TREND_UP')).toEqual({
        setup: setup(facts),
        source: { strategyKey: key, facts },
        sweptLevelId,
        structureTarget,
      });
    },
  );

  it('asks strategy B about the regime and the others about nothing', () => {
    for (const key of KEYS) runnerOf(specOf(key)).find('RANGE');
    expect(callsOf('sweep_reversal', 'evaluate')[0]?.args).toEqual(['RANGE']);
    for (const key of KEYS.filter((other) => other !== 'sweep_reversal')) {
      expect(callsOf(key, 'evaluate')).toEqual([{ strategy: key, method: 'evaluate', args: [] }]);
    }
  });
});

describe('DecisionEngine: what it hands to the strategies and takes from them', () => {
  const specFor = (key: StrategyKey): StrategySpec => {
    const found = [pullbackSpec(), ...otherSpecs()].find((spec) => spec.strategyKey === key);
    if (found === undefined) throw new Error('no spec');
    return found;
  };

  it('feeds strategy B the liquidity levels that applied to the 5m candle, the very list of the market', () => {
    const engine = new DecisionEngine([specFor('sweep_reversal')]);
    const next = random(9);
    const closes = walk(
      4000,
      Array.from({ length: 400 }, () => (next() - 0.5) * 8),
    );
    let withLevels = 0;
    for (const [i, candle] of fromCloses(
      closes,
      300_000,
      (n) => 0.1 + ((n * 7) % 5) * 0.08,
    ).entries()) {
      engine.push('5m', { ...candle, openTime: 1_700_000_000_000 + i * 300_000, spread: 0.2 });
      const fed = callsOf('sweep_reversal', 'updateFive').at(-1)?.args[1];
      expect(fed).toBe(engine.market.levelsOfNewestFive);
      if (engine.market.levelsOfNewestFive.length > 0) withLevels += 1;
    }
    expect(withLevels).toBeGreaterThan(50);
  });

  it('asks strategy B about the regime of the market, and nothing before the regime is known', () => {
    const early = new DecisionEngine([specFor('sweep_reversal')]);
    for (const candle of seriesOf(BASE)['5m'].slice(0, 5)) early.push('5m', candle);
    early.candidates();
    expect(callsOf('sweep_reversal', 'evaluate').at(-1)?.args).toEqual([null]);

    // a long market, so that the regime classifier has what it needs
    const next = random(3);
    const withSpread = (candles: readonly StructureCandle[]): EngineCandle[] =>
      candles.map((candle) => ({ ...candle, spread: 0.2 }));
    const wick = (n: number) => 0.1 + ((n * 7) % 5) * 0.08;
    const five = fromCloses(
      walk(
        4300,
        Array.from({ length: 4_500 }, () => next() - 0.5),
      ),
      300_000,
      wick,
    ).map((candle, i) => ({ ...candle, openTime: 1_700_000_000_000 + i * 300_000 }));
    const known = new DecisionEngine([specFor('sweep_reversal')]);
    for (const step of mergeByClose({
      '1h': withSpread(hourlyUp(300)),
      '15m': withSpread(
        fromCloses(
          walk(
            4000,
            Array.from({ length: 1_200 }, () => (next() - 0.5) * 3),
          ),
          QUARTER_MS,
          wick,
        ),
      ),
      '5m': withSpread(five),
    })) {
      known.push(step.tf, step.candle);
    }
    spy.calls.length = 0;
    known.candidates();
    const regime = known.view()?.regime?.regime;
    expect(regime).toBeDefined();
    expect(callsOf('sweep_reversal', 'evaluate').at(-1)?.args).toEqual([regime]);
  });

  it('leaves the level that strategy B sweeps out of the levels that stand in the way of the trade', () => {
    const spec = specFor('sweep_reversal');
    const engine = new DecisionEngine([
      { ...spec, gates: { ...spec.gates, quality: { min: 100, minCoverage: 0.4 } } },
    ]);
    const start = 1_700_000_000_000;
    const bar = (openTime: number, c: number) => ({
      openTime,
      o: c,
      h: c + 0.2,
      l: c - 0.2,
      c,
      spread: 0.1,
    });
    engine.push('1h', bar(start - 7_200_000, 4099));
    engine.push('15m', bar(start - 1_800_000, 4099));
    const closes = walk(
      4099,
      Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.3 : -0.3)),
    );
    for (const [i, candle] of fromCloses(
      closes,
      300_000,
      (n) => 0.1 + ((n * 7) % 5) * 0.08,
    ).entries()) {
      engine.push('5m', { ...candle, openTime: start + i * 300_000, spread: 0.1 });
    }
    const view = engine.view();
    const quote = { t: (view?.openTime ?? 0) + 300_000, bid: 4099.74, ask: 4099.86 };
    const codes = (levelId: string) => {
      spy.answers.set('sweep_reversal', {
        setup: {
          side: 'BUY',
          setupKey: 'sweep_reversal:5m:x',
          stopLoss: 4097,
          facts: { levelId, depthAtr: 0.5, wickRatio: 0.6 },
        },
      });
      const [outcome] = decideNow(engine, { quote, modes: { nearLevel: 'block' } }).outcomes;
      return outcome?.kind === 'REJECTED' ? outcome.rejection.codes : null;
    };
    // the round number 4100 is a hair above the entry (4099.91): an obstacle, unless it is the level that was swept
    expect(codes('L-other')).toEqual(['QUALITY_OK', 'NEAR_LEVEL']);
    expect(codes('ROUND:4100')).toEqual(['QUALITY_OK']);
  });

  it('holds strategy E to its measured move: a target closer than the minimum is TARGET_OK, with the reason', () => {
    const spec = specFor('pattern_breakout');
    if (spec.strategyKey !== 'pattern_breakout') throw new Error('not strategy E');
    const engine = engineAt(BASE, [spec], 53);
    const close = engine.view()?.close ?? 0;
    // a stop 3 below the close and a target 3.4 above it: well under 1.5 R from the real entry
    spy.answers.set('pattern_breakout', {
      setup: {
        side: 'BUY',
        setupKey: 'pattern_breakout:15m:x',
        stopLoss: close - 3,
        facts: { target: close + 3.4 },
      },
    });
    const decision = decideNow(engine);
    const [outcome] = decision.outcomes;
    expect(outcome?.kind).toBe('REJECTED');
    expect(outcome?.kind === 'REJECTED' ? outcome.rejection : null).toMatchObject({
      strategyKey: 'pattern_breakout',
      codes: ['TARGET_OK'],
      detail: { reason: 'MEASURED_MOVE_TOO_SMALL' },
    });
  });
});
