import { describe, expect, it } from 'vitest';

import { QUALITY_GROUPS } from '../domain';
import {
  chartStateText,
  emaOrderText,
  groupFacts,
  signedTwoText,
  wholeText,
  type MarketNumbers,
} from './facts';
import { BUY_INPUTS, NO_INPUTS, inputsWith } from './test-data';

const MARKET: MarketNumbers = { atr5: 4.3, spread: 0.12 };
const facts = (group: (typeof QUALITY_GROUPS)[number], inputs = BUY_INPUTS, market = MARKET) =>
  groupFacts(group, inputs, market);

describe('emaOrderText', () => {
  it('names the EMAs from the highest to the lowest, as the chart shows them', () => {
    expect(emaOrderText(4020, 4015, 4000)).toBe('20>50>200');
    expect(emaOrderText(4000, 4015, 4020)).toBe('200>50>20');
    expect(emaOrderText(4010, 4020, 4000)).toBe('50>20>200');
    expect(emaOrderText(4010, 4000, 4020)).toBe('200>20>50');
  });

  it('writes equal EMAs with an equals sign', () => {
    expect(emaOrderText(4015, 4015, 4000)).toBe('20=50>200');
    expect(emaOrderText(4020, 4000, 4000)).toBe('20>50=200');
    expect(emaOrderText(4000, 4000, 4000)).toBe('20=50=200');
  });
});

describe('small helpers', () => {
  it('words the state of a chart, and rounds', () => {
    expect(chartStateText('UP')).toBe('up');
    expect(chartStateText('DOWN')).toBe('down');
    expect(chartStateText('RANGE')).toBe('range');
    expect(chartStateText(null)).toBe('n/a');
    expect(signedTwoText(0.314)).toBe('+0.31');
    expect(signedTwoText(-0.2)).toBe('-0.20');
    expect(signedTwoText(0)).toBe('0.00');
    expect(signedTwoText(-0.001)).toBe('0.00');
    expect(wholeText(30.5)).toBe('31');
  });
});

describe('trend facts', () => {
  it('shows the EMA order, the slope, ADX with its DI and the Supertrend', () => {
    expect(facts('trend')).toEqual([
      { label: '1h EMA', value: '20>50>200' },
      { label: '1h EMA 50 slope (3 h)', value: '+0.50 ATR(1h)' },
      { label: 'ADX(1h)', value: '31 (+DI 30 / -DI 10)' },
      { label: 'Supertrend 1h', value: 'up' },
    ]);
  });

  it('shows the real chart, not the side of the trade', () => {
    const down = inputsWith({
      trend: {
        ema20: 4000,
        ema50: 4010,
        ema200: 4020,
        ema50SlopeAtr: -0.2,
        adx: 24.4,
        plusDI: 12,
        minusDI: 28,
        supertrend: 'DOWN',
      },
    });
    expect(facts('trend', down)).toEqual([
      { label: '1h EMA', value: '200>50>20' },
      { label: '1h EMA 50 slope (3 h)', value: '-0.20 ATR(1h)' },
      { label: 'ADX(1h)', value: '24 (+DI 12 / -DI 28)' },
      { label: 'Supertrend 1h', value: 'down' },
    ]);
  });

  it('shows ADX as a number when the DI is not there, and a flat slope as zero', () => {
    const partial = inputsWith({
      trend: { ...BUY_INPUTS.trend, plusDI: null, ema50SlopeAtr: 0 },
    });
    expect(facts('trend', partial)).toEqual([
      { label: '1h EMA', value: '20>50>200' },
      { label: '1h EMA 50 slope (3 h)', value: '0.00 ATR(1h)' },
      { label: 'ADX(1h)', value: 31 },
      { label: 'Supertrend 1h', value: 'up' },
    ]);
  });

  it('needs all three EMAs for the order', () => {
    const partial = inputsWith({ trend: { ...BUY_INPUTS.trend, ema200: null } });
    expect(facts('trend', partial).map((fact) => fact.label)).not.toContain('1h EMA');
  });
});

describe('structure facts', () => {
  it('shows the chart state, the latest break and the confluence', () => {
    expect(facts('structure')).toEqual([
      { label: 'Structure 15m / 5m', value: 'up / up' },
      { label: 'Latest 5m break', value: 'with the trade' },
      { label: 'Trendline and zone confluence', value: '2 agree' },
    ]);
  });

  it('shows what is known of the chart and says n/a for the rest', () => {
    const partial = inputsWith({
      structure: { ...BUY_INPUTS.structure, state15m: null, state5m: 'RANGE', breakEvent: 'NONE' },
    });
    expect(facts('structure', partial).slice(0, 2)).toEqual([
      { label: 'Structure 15m / 5m', value: 'n/a / range' },
      { label: 'Latest 5m break', value: 'none' },
    ]);
  });

  it('words a break against the trade, and a fractional confluence', () => {
    const against = inputsWith({
      structure: { ...BUY_INPUTS.structure, breakEvent: 'AGAINST', confluence: 1.5 },
    });
    expect(facts('structure', against)).toEqual([
      { label: 'Structure 15m / 5m', value: 'up / up' },
      { label: 'Latest 5m break', value: 'against the trade' },
      { label: 'Trendline and zone confluence', value: '1.5 agree' },
    ]);
  });

  it('adds the sweep of strategy B and the measured move of strategy E', () => {
    const own = inputsWith({
      structure: {
        ...BUY_INPUTS.structure,
        sweep: { depthAtr: 0.35, wickRatio: 0.65 },
        patternMoveR: 2.1,
      },
    });
    expect(facts('structure', own).slice(2)).toEqual([
      { label: 'Sweep', value: '0.35 x ATR deep, wick 65%' },
      { label: 'Trendline and zone confluence', value: '2 agree' },
      { label: 'Measured move', value: '2.10R' },
    ]);
  });
});

describe('trigger facts', () => {
  it('shows the candle, the RSI move and the MACD run', () => {
    expect(facts('trigger')).toEqual([
      { label: 'Trigger candle', value: 'range 1.4 x ATR, closed at 85% of its range' },
      { label: 'RSI(5m)', value: '38 → 54' },
      { label: 'MACD histogram', value: 'rising 3 candles' },
    ]);
  });

  it('shows a falling or flat histogram, and a fractional run', () => {
    const run = (macdBars: number) =>
      facts('trigger', inputsWith({ trigger: { ...BUY_INPUTS.trigger, macdBars } })).at(-1);
    expect(run(-2)).toEqual({ label: 'MACD histogram', value: 'falling 2 candles' });
    expect(run(0)).toEqual({ label: 'MACD histogram', value: 'flat' });
    expect(run(1.5)).toEqual({ label: 'MACD histogram', value: 'rising 1.5 candles' });
  });

  it('shows the candle from either of its two numbers', () => {
    const only = (change: Partial<typeof BUY_INPUTS.trigger>) =>
      facts('trigger', inputsWith({ trigger: { ...BUY_INPUTS.trigger, ...change } }))[0];
    expect(only({ closeLocation: null })).toEqual({
      label: 'Trigger candle',
      value: 'range 1.4 x ATR',
    });
    expect(only({ rangeAtr: null })).toEqual({
      label: 'Trigger candle',
      value: 'closed at 85% of its range',
    });
  });

  it('needs both RSI values for the RSI move', () => {
    const labels = (change: Partial<typeof BUY_INPUTS.trigger>) =>
      facts('trigger', inputsWith({ trigger: { ...BUY_INPUTS.trigger, ...change } })).map(
        (fact) => fact.label,
      );
    expect(labels({ rsiNow: null })).not.toContain('RSI(5m)');
    expect(labels({ rsiExtreme: null })).not.toContain('RSI(5m)');
  });
});

describe('volatility and execution facts', () => {
  it('shows the ATR, its percentile and the squeeze', () => {
    expect(facts('volatility')).toEqual([
      { label: 'ATR(5m)', value: 4.3 },
      { label: 'ATR percentile', value: '62nd' },
      { label: 'Squeeze', value: 'none' },
    ]);
  });

  it('words the squeeze and rounds the ATR to 2 decimals', () => {
    const squeeze = (value: 'RELEASED' | 'NONE' | 'ON') =>
      facts('volatility', inputsWith({ volatility: { atrPercentile: null, squeeze: value } }), {
        atr5: 4.3456,
        spread: null,
      });
    expect(squeeze('RELEASED')).toEqual([
      { label: 'ATR(5m)', value: 4.35 },
      { label: 'Squeeze', value: 'just released' },
    ]);
    expect(squeeze('ON')[1]).toEqual({ label: 'Squeeze', value: 'still on' });
  });

  it('shows the spread, its percentile and the stop distance', () => {
    expect(facts('execution')).toEqual([
      { label: 'Spread', value: 0.12 },
      { label: 'Spread percentile', value: '35th' },
      { label: 'Stop distance', value: '1.5 x ATR' },
    ]);
  });

  it('leaves out a spread that is not known', () => {
    expect(facts('execution', BUY_INPUTS, { atr5: 4.3, spread: null }).map((f) => f.label)).toEqual(
      ['Spread percentile', 'Stop distance'],
    );
  });

  it('rounds the spread to 3 decimals, as it is stored', () => {
    expect(facts('execution', BUY_INPUTS, { atr5: 4.3, spread: 0.1234 })[0]).toEqual({
      label: 'Spread',
      value: 0.123,
    });
  });
});

describe('session and macro facts', () => {
  const news = (state: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN', minutesToNext: number | null) =>
    facts(
      'sessionMacro',
      inputsWith({ sessionMacro: { session: 'LONDON', news: { state, minutesToNext } } }),
    );

  it('shows the session and the time to the next high-impact event', () => {
    expect(facts('sessionMacro')).toEqual([
      { label: 'Session', value: 'London' },
      { label: 'High-impact USD event', value: 'in 4 h 25 min' },
    ]);
  });

  it('words the state of the calendar', () => {
    expect(news('CLEAR', null)[1]).toEqual({ label: 'High-impact USD event', value: 'none known' });
    expect(news('IN_WINDOW', 10)[1]).toEqual({
      label: 'High-impact USD event',
      value: 'inside the news window',
    });
    expect(news('UNKNOWN', null)[1]).toEqual({
      label: 'High-impact USD event',
      value: 'calendar unavailable',
    });
  });

  it('names every session', () => {
    const name = (session: 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEW_YORK' | 'ROLLOVER') =>
      facts('sessionMacro', inputsWith({ sessionMacro: { session, news: null } }))[0]?.value;
    expect(name('ASIA')).toBe('Asia');
    expect(name('LONDON')).toBe('London');
    expect(name('OVERLAP')).toBe('London and New York overlap');
    expect(name('NEW_YORK')).toBe('New York');
    expect(name('ROLLOVER')).toBe('Rollover');
  });
});

describe('reward facts', () => {
  it('shows the distance to TP1 and the room to the next level', () => {
    expect(facts('reward')).toEqual([
      { label: 'TP1 distance', value: '1.5 x ATR' },
      { label: 'Room to the next level', value: '2.3 x the distance to TP1' },
    ]);
  });

  it('words no level ahead', () => {
    expect(facts('reward', inputsWith({ reward: { tp1Atr: 1.2, levelRoom: 'NONE' } }))).toEqual([
      { label: 'TP1 distance', value: '1.2 x ATR' },
      { label: 'Room to the next level', value: 'no level ahead' },
    ]);
  });
});

describe('a group without data', () => {
  it('has no facts, except the ATR that is always known', () => {
    for (const group of QUALITY_GROUPS) {
      const expected = group === 'volatility' ? [{ label: 'ATR(5m)', value: 4.3 }] : [];
      expect(facts(group, NO_INPUTS, { atr5: 4.3, spread: null }), group).toEqual(expected);
    }
  });
});
