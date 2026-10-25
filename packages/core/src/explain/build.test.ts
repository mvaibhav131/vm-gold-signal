import { describe, expect, it } from 'vitest';

import { QUALITY_GROUPS } from '../domain';
import { qualityStrengths, scoreQuality } from '../scoring/score';
import { buildExplanation } from './build';
import {
  BUY_INPUTS,
  NO_INPUTS,
  PATTERN,
  SELL_INPUTS,
  SQUEEZE,
  SWEEP,
  TRENDLINE,
  WEIGHTS,
  EVIDENCE_NORMAL,
  explanationInputOf,
  flagOf,
  inputsWith,
} from './test-data';

describe('the explanation of the example', () => {
  const doc = buildExplanation(explanationInputOf());

  it('has the headline, the quality and the levels of the signal', () => {
    expect(doc.headline).toBe('BUY XAUUSD - Trend Pullback v0.1.0');
    expect(doc.quality).toEqual({ score: 95.33, grade: 'Very strong' });
    expect(doc.levels).toEqual({
      entry: 4017.37,
      maxValidEntry: 4018.015,
      stop: 4010.9,
      tp1: 4023.84,
      tp2: 4030.31,
      riskUsd: 6.47,
    });
  });

  it('has the seven groups in the order of the score, each with the state it was scored at', () => {
    expect(doc.groups.map((group) => group.key)).toEqual([...QUALITY_GROUPS]);
    expect(doc.groups.map((group) => group.state)).toEqual(Array<string>(7).fill('STRONG'));
  });

  it('adds the lines of the strategy to the structure and the trigger group, after the scored facts', () => {
    const labels = (key: string) =>
      doc.groups.find((group) => group.key === key)?.facts.map((fact) => fact.label);
    expect(labels('structure')).toEqual([
      'Structure 15m / 5m',
      'Latest 5m break',
      'Trendline and zone confluence',
      'Pullback',
      '5m swing level',
    ]);
    expect(labels('trigger')).toEqual([
      'Trigger candle',
      'RSI(5m)',
      'MACD histogram',
      'Displacement candle',
    ]);
    expect(labels('trend')).toEqual([
      '1h EMA',
      '1h EMA 50 slope (3 h)',
      'ADX(1h)',
      'Supertrend 1h',
    ]);
  });

  it('has the weak points, the research-only readings and the macro state', () => {
    expect(doc.weak).toEqual([]);
    expect(doc.researchOnly).toEqual([
      { label: 'DXY 15m', value: '-0.2%' },
      { label: 'Silver 15m', value: '+0.3%' },
    ]);
    expect(doc.macro).toEqual({
      state: 'CLEAR',
      next: { name: 'CPI m/m', at: '2026-10-23T10:30:00.000Z' },
    });
  });

  it('has the news, the warnings, the open risk and the evidence as given', () => {
    expect(doc.news).toEqual({ feed: 'AVAILABLE', headlines: [] });
    expect(doc.warnings).toEqual([
      {
        code: 'UNVALIDATED_STRATEGY',
        text: 'FORWARD-TEST: this strategy is not validated yet (paper signal)',
      },
    ]);
    expect(doc.open).toEqual({ count: 0, riskR: 0 });
    expect(doc.evidence.n).toBe(64);
    expect(doc.evidence.sampleLabel).toBe('LOW_SAMPLE');
  });

  it('is the same every time it is built', () => {
    expect(buildExplanation(explanationInputOf())).toEqual(doc);
  });
});

describe('what the explanation takes from its input', () => {
  it('names every strategy and both sides in the headline', () => {
    const headline = (
      setup: Parameters<typeof explanationInputOf>[0],
      side: 'BUY' | 'SELL' = 'BUY',
    ) =>
      buildExplanation(
        explanationInputOf({ ...setup, side, inputs: side === 'SELL' ? SELL_INPUTS : BUY_INPUTS }),
      ).headline;
    expect(headline({ setup: { strategyKey: 'sweep_reversal', facts: SWEEP } })).toBe(
      'BUY XAUUSD - Liquidity Sweep Reversal v0.1.0',
    );
    expect(headline({ setup: { strategyKey: 'squeeze_retest', facts: SQUEEZE } })).toBe(
      'BUY XAUUSD - Squeeze Breakout and Retest v0.1.0',
    );
    expect(headline({ setup: { strategyKey: 'trendline_retest', facts: TRENDLINE } })).toBe(
      'BUY XAUUSD - Trendline Break and Retest v0.1.0',
    );
    expect(headline({ setup: { strategyKey: 'pattern_breakout', facts: PATTERN } }, 'SELL')).toBe(
      'SELL XAUUSD - Chart Pattern Breakout v0.1.0',
    );
  });

  it('takes the version of the strategy', () => {
    expect(buildExplanation(explanationInputOf({ strategyVersion: '1.2.3' })).headline).toBe(
      'BUY XAUUSD - Trend Pullback v1.2.3',
    );
  });

  it('takes a SELL level set as it is', () => {
    const doc = buildExplanation(
      explanationInputOf({
        side: 'SELL',
        inputs: SELL_INPUTS,
        plan: {
          entry: 3982.63,
          maxValidEntry: 3981.985,
          stopLoss: 3989.1,
          tp1: 3976.16,
          tp2: 3969.69,
          riskDistance: 6.47,
        },
      }),
    );
    expect(doc.levels).toEqual({
      entry: 3982.63,
      maxValidEntry: 3981.985,
      stop: 3989.1,
      tp1: 3976.16,
      tp2: 3969.69,
      riskUsd: 6.47,
    });
  });

  it('has no second target for a single-target plan', () => {
    const plan = { ...explanationInputOf().plan, tp1: 4027.075, tp2: null };
    expect(buildExplanation(explanationInputOf({ plan })).levels.tp2).toBeNull();
  });

  it('turns the next event into an ISO time, and accepts none', () => {
    const none = buildExplanation(explanationInputOf({ macro: { state: 'UNKNOWN', next: null } }));
    expect(none.macro).toEqual({ state: 'UNKNOWN', next: null });
  });

  it('copies what it is given, so that the stored explanation is its own', () => {
    const input = explanationInputOf({
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
    });
    const doc = buildExplanation(input);
    expect(doc.news.headlines).toEqual(input.news.headlines);
    expect(doc.news.headlines).not.toBe(input.news.headlines);
    expect(doc.researchOnly).not.toBe(input.researchOnly);
  });

  it('has no research-only readings when none is given', () => {
    const { researchOnly: _unused, ...rest } = explanationInputOf();
    expect(buildExplanation(rest).researchOnly).toEqual([]);
  });

  it('takes the evidence and the open risk as given', () => {
    const doc = buildExplanation(
      explanationInputOf({ evidence: EVIDENCE_NORMAL, open: { count: 2, riskR: 2 } }),
    );
    expect(doc.evidence).toEqual(EVIDENCE_NORMAL);
    expect(doc.open).toEqual({ count: 2, riskR: 2 });
  });

  it('turns the flags that are on into warnings, with their context', () => {
    const doc = buildExplanation(
      explanationInputOf({
        flags: [
          flagOf('NEWS_WINDOW', { minutesToEvent: 20, settling: false }),
          flagOf('ROLLOVER', {}, false),
          flagOf('OPPOSES_OPEN', { signalIds: ['x'] }),
        ],
        warningContext: { eventName: 'CPI m/m', openLabels: { x: '#S-0041' } },
      }),
    );
    expect(doc.warnings).toEqual([
      { code: 'NEWS_WINDOW', text: 'News window: CPI m/m in 20 min' },
      { code: 'OPPOSES_OPEN', text: 'Opposes open signal #S-0041' },
    ]);
  });
});

describe('the weak groups', () => {
  it('shows the weak points and the state of a weak group', () => {
    const inputs = inputsWith({
      trigger: { rangeAtr: 0.7, closeLocation: 0.55, rsiNow: 41, rsiExtreme: 38, macdBars: 0 },
    });
    const doc = buildExplanation(explanationInputOf({ inputs }));
    const trigger = doc.groups.find((group) => group.key === 'trigger');
    expect(trigger?.state).toBe('FAIL');
    expect(doc.weak).toEqual([
      'the RSI has barely reset from its pullback extreme',
      'the MACD histogram does not support the trade',
      'the trigger candle is small (0.7 x ATR)',
      'the trigger candle closed far from its extreme (at 55% of its range)',
    ]);
  });

  it('marks a group without data as NA, with no facts of its own', () => {
    const inputs = { ...BUY_INPUTS, reward: NO_INPUTS.reward };
    const doc = buildExplanation(explanationInputOf({ inputs }));
    expect(doc.groups.at(-1)).toEqual({ key: 'reward', state: 'NA', facts: [] });
  });
});

describe('a setup without a grade is no signal', () => {
  it('refuses a score below 65', () => {
    const inputs = inputsWith({
      trend: { ...NO_INPUTS.trend, supertrend: 'DOWN' },
      structure: { ...NO_INPUTS.structure, breakEvent: 'AGAINST' },
    });
    const quality = scoreQuality(qualityStrengths('BUY', inputs), WEIGHTS);
    expect(quality.grade).toBeNull();
    expect(() => buildExplanation(explanationInputOf({ inputs, quality }))).toThrow(RangeError);
  });

  it('refuses no score at all', () => {
    const quality = scoreQuality(qualityStrengths('BUY', NO_INPUTS), WEIGHTS);
    expect(quality.score).toBeNull();
    expect(() => buildExplanation(explanationInputOf({ quality }))).toThrow(RangeError);
  });

  it('refuses a quality result that lacks a group', () => {
    const quality = scoreQuality(qualityStrengths('BUY', BUY_INPUTS), WEIGHTS);
    const missing = { ...quality, groups: quality.groups.slice(1) };
    expect(() => buildExplanation(explanationInputOf({ quality: missing }))).toThrow(RangeError);
  });
});
