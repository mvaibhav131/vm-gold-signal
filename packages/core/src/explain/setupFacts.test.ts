import { describe, expect, it } from 'vitest';

import { STRATEGY_KEYS } from '../domain';
import type { PatternName } from '../patterns/types';
import { PATTERN_TEXT, STRATEGY_NAMES, matchLevelText } from './names';
import { setupFacts } from './setupFacts';
import { PATTERN, PULLBACK, SQUEEZE, SWEEP, TRENDLINE } from './test-data';

describe('trend pullback lines', () => {
  it('names the pullback leg, the swing level and the displacement', () => {
    expect(setupFacts({ strategyKey: 'trend_pullback', facts: PULLBACK })).toEqual({
      structure: [
        { label: 'Pullback', value: '4021.300 → 4012.800, EMA and Fibonacci zone' },
        { label: '5m swing level', value: '4014.200, closed beyond it' },
      ],
      trigger: [{ label: 'Displacement candle', value: 'yes' }],
    });
  });

  it('words the zone and the swing level that is not broken, or not there', () => {
    const lines = (change: Partial<typeof PULLBACK>) =>
      setupFacts({ strategyKey: 'trend_pullback', facts: { ...PULLBACK, ...change } });
    expect(lines({ zone: 'EMA' }).structure[0]?.value).toBe('4021.300 → 4012.800, EMA zone');
    expect(lines({ zone: 'FIB' }).structure[0]?.value).toBe('4021.300 → 4012.800, Fibonacci zone');
    expect(lines({ brokeLevel: false }).structure[1]?.value).toBe('4014.200, not broken yet');
    expect(lines({ breakLevel: null, brokeLevel: false }).structure).toHaveLength(1);
    expect(lines({ displacement: false }).trigger).toEqual([
      { label: 'Displacement candle', value: 'no' },
    ]);
  });
});

describe('liquidity sweep lines', () => {
  it('names the swept level, both CHoCH and the trigger candle', () => {
    expect(setupFacts({ strategyKey: 'sweep_reversal', facts: SWEEP })).toEqual({
      structure: [
        { label: 'Swept level', value: '4012.400 (extreme 4011.500), reclaimed 3 candles ago' },
        { label: '5m CHoCH', value: 'broke 4016.500' },
        { label: '15m CHoCH', value: 'yes' },
      ],
      trigger: [
        { label: 'Trigger candle size', value: '1.4 x ATR' },
        { label: 'RSI divergence', value: 'yes' },
      ],
    });
  });

  it('words a single candle, no 15m CHoCH and no divergence', () => {
    const lines = setupFacts({
      strategyKey: 'sweep_reversal',
      facts: { ...SWEEP, candlesSinceReclaim: 1, choch15m: false, rsiDivergence: false },
    });
    expect(lines.structure[0]?.value).toBe('4012.400 (extreme 4011.500), reclaimed 1 candle ago');
    expect(lines.structure[2]).toEqual({ label: '15m CHoCH', value: 'no' });
    expect(lines.trigger).toEqual([{ label: 'Trigger candle size', value: '1.4 x ATR' }]);
  });
});

describe('squeeze breakout lines', () => {
  it('names the breakout, the squeeze and the retest', () => {
    expect(setupFacts({ strategyKey: 'squeeze_retest', facts: SQUEEZE })).toEqual({
      structure: [
        {
          label: 'Breakout level',
          value: '4018.000, closed 0.4 x ATR beyond it, displacement 1.6 x ATR',
        },
        { label: 'Squeeze (15m)', value: 'lasted 22 candles, released 1 candle ago' },
      ],
      trigger: [{ label: 'Retest', value: 'held 4018.000: went 0.05 x ATR through it, wick 40%' }],
    });
  });

  it('words a retest that stayed away from the level', () => {
    const lines = setupFacts({
      strategyKey: 'squeeze_retest',
      facts: { ...SQUEEZE, retestDistanceAtr: 0.2, candlesSinceRelease15m: 9 },
    });
    expect(lines.trigger[0]?.value).toBe('held 4018.000: stayed 0.20 x ATR away, wick 40%');
    expect(lines.structure[1]?.value).toBe('lasted 22 candles, released 9 candles ago');
  });

  it('treats a retest exactly at the level as staying away by zero', () => {
    const lines = setupFacts({
      strategyKey: 'squeeze_retest',
      facts: { ...SQUEEZE, retestDistanceAtr: 0 },
    });
    expect(lines.trigger[0]?.value).toBe('held 4018.000: stayed 0.00 x ATR away, wick 40%');
  });
});

describe('trendline retest lines', () => {
  it('rounds the RSI at the retest to a whole number', () => {
    const rsi = (value: number) =>
      setupFacts({ strategyKey: 'trendline_retest', facts: { ...TRENDLINE, rsi: value } })
        .trigger[1];
    expect(rsi(52.6)).toEqual({ label: 'RSI at the retest', value: 53 });
    expect(rsi(52.4)).toEqual({ label: 'RSI at the retest', value: 52 });
  });
  it('names the line, the break, the retest and the RSI', () => {
    expect(setupFacts({ strategyKey: 'trendline_retest', facts: TRENDLINE })).toEqual({
      structure: [
        {
          label: 'Trendline 15m',
          value: '3 touches, 4015.600 at the retest, broken 5 candles ago',
        },
        { label: 'Break', value: '0.3 x ATR beyond the line, body 70% of the candle' },
      ],
      trigger: [
        { label: 'Retest', value: 'held 4015.600: stayed 0.20 x ATR away, wick 45%' },
        { label: 'RSI at the retest', value: 52 },
      ],
    });
  });
});

describe('chart pattern lines', () => {
  it('names the pattern as the chart shows it, its target and the break', () => {
    expect(setupFacts({ strategyKey: 'pattern_breakout', facts: PATTERN })).toEqual({
      structure: [
        {
          label: 'Pattern 15m',
          value: 'double bottom, boundary 4018.000, target 4030.900 (2.10R)',
        },
        {
          label: 'Break',
          value: '0.2 x ATR beyond the boundary, displacement 1.5 x ATR, 3 candles ago',
        },
      ],
      trigger: [{ label: 'Retest', value: 'held 4018.000: stayed 0.20 x ATR away, wick 40%' }],
    });
  });

  it('has words for every pattern, in lower case', () => {
    const names: PatternName[] = [
      'DOUBLE_TOP',
      'DOUBLE_BOTTOM',
      'HEAD_AND_SHOULDERS',
      'INVERSE_HEAD_AND_SHOULDERS',
      'ASCENDING_TRIANGLE',
      'DESCENDING_TRIANGLE',
      'SYMMETRICAL_TRIANGLE',
      'BULL_FLAG',
      'BEAR_FLAG',
      'BULL_PENNANT',
      'BEAR_PENNANT',
      'RISING_WEDGE',
      'FALLING_WEDGE',
      'RECTANGLE',
    ];
    expect(Object.keys(PATTERN_TEXT).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(PATTERN_TEXT[name]).toBe(name.toLowerCase().replace(/_/g, ' '));
    }
  });
});

describe('hourly trend lines', () => {
  const facts = {
    trend: 'UP',
    hourOpen: Date.UTC(2026, 9, 23, 8, 0),
    hourClose: 4020,
    emaFast: 4012.5,
    emaMid: 4005,
    emaSlow: 3990,
    atr1h: 8.4,
    stopAtr1h: 2.5,
  } as const;

  it('names the 1h averages and the price, and the stop', () => {
    expect(setupFacts({ strategyKey: 'hourly_trend', facts })).toEqual({
      structure: [
        {
          label: 'Trend 1h',
          value: 'up: EMA 20 4012.500 over EMA 50 4005.000, close 4020.000 above EMA 200 3990.000',
        },
      ],
      trigger: [
        {
          label: 'Slot decision',
          value: 'with the trend, stop 2.5 x ATR 1h (8.400) from the price',
        },
      ],
    });
  });

  it('words a downtrend with the same real prices, the other way round', () => {
    const lines = setupFacts({
      strategyKey: 'hourly_trend',
      facts: {
        ...facts,
        trend: 'DOWN',
        hourClose: 3980,
        emaFast: 3985,
        emaMid: 3990,
        emaSlow: 4000,
      },
    });
    expect(lines.structure[0]?.value).toBe(
      'down: EMA 20 3985.000 under EMA 50 3990.000, close 3980.000 below EMA 200 4000.000',
    );
  });
});

describe('confluence lines', () => {
  const facts = {
    trend1h: 'UP',
    trend15m: 'UP',
    votes: ['TREND_1H', 'TREND_15M', 'EMA_STACK_5M', 'ADX', 'DAY_MEAN', 'BREAKOUT', 'MACD'],
    rsi: 61.4,
    macdHistogram: 0.34,
    adx: 27.2,
    plusDI: 29.6,
    minusDI: 14.1,
    atr5m: 3.5,
    atrRatio: 1.12,
    emaFast5m: 4008,
    emaMid5m: 4004,
    dayMean: 4000,
    swingLevel: 4003.2,
    stopAtr: 3.4,
    stopUsd: 11.9,
  } as const;

  it('names the two trends, the stop structure, the votes that agreed and the numbers behind them', () => {
    expect(setupFacts({ strategyKey: 'confluence', facts })).toEqual({
      structure: [
        { label: 'Trend 1h / 15m', value: 'up / up' },
        {
          label: 'Stop structure',
          value: 'swing 4003.200, stop 3.4 x ATR (11.900 USD) from the close',
        },
      ],
      trigger: [
        {
          label: 'Votes',
          value:
            '7 of 9: 1h trend, 15m trend, 5m EMA 20/50, ADX, day mean, 6-candle breakout, MACD',
        },
        {
          label: 'Momentum',
          value: 'RSI 61, ADX 27 (+DI 30 / -DI 14), MACD histogram 0.34',
        },
        { label: 'Range of the market', value: 'ATR(5m) 3.500, 1.12 x its average of the day' },
      ],
    });
  });

  it('words a missing trend and the other direction', () => {
    const lines = setupFacts({
      strategyKey: 'confluence',
      facts: { ...facts, trend1h: null, trend15m: 'DOWN', votes: ['TREND_15M'] },
    });
    expect(lines.structure[0]?.value).toBe('none / down');
    expect(lines.trigger[0]?.value).toBe('1 of 9: 15m trend');
  });
});

describe('names', () => {
  it('has a name for every strategy', () => {
    expect(Object.keys(STRATEGY_NAMES).sort()).toEqual([...STRATEGY_KEYS].sort());
  });

  it('words the bucket of the evidence for each level, and the last one beyond it', () => {
    expect(matchLevelText(0)).toBe('strategy, side, session, regime and volatility');
    expect(matchLevelText(2)).toBe('strategy, side and session');
    expect(matchLevelText(4)).toBe('strategy and side, all versions');
    expect(matchLevelText(9)).toBe('strategy and side, all versions');
  });
});
