import type { QualityGroup } from '../domain';
import type { ChartState, QualityInputs } from '../scoring/groups';
import { roundTo } from '../trade/round';
import {
  atrText,
  countText,
  fixedText,
  ordinalText,
  percentText,
  plainRText,
  spanText,
} from './format';
import { SESSION_NAMES } from './names';
import type { ExplanationFact } from './types';

/** The market numbers beside the scored facts: the ATR(5m) and the spread of the confirming tick. */
export interface MarketNumbers {
  readonly atr5: number;
  readonly spread: number | null;
}

const stateWord = (state: ChartState | null): string =>
  state === null ? 'n/a' : state === 'UP' ? 'up' : state === 'DOWN' ? 'down' : 'range';

/** `20>50>200`: the order of the three EMAs as the chart shows it (equal ones with `=`). */
export function emaOrderText(ema20: number, ema50: number, ema200: number): string {
  const sorted = [
    { period: 20, value: ema20 },
    { period: 50, value: ema50 },
    { period: 200, value: ema200 },
  ].sort((a, b) => b.value - a.value);
  return sorted
    .map((entry, index) => {
      const next = sorted[index + 1];
      if (next === undefined) return String(entry.period);
      return `${String(entry.period)}${entry.value === next.value ? '=' : '>'}`;
    })
    .join('');
}

const signedTwo = (value: number): string => {
  const text = fixedText(Math.abs(value), 2);
  if (Number(text) === 0) return text;
  return `${value < 0 ? '-' : '+'}${text}`;
};

const whole = (value: number): string => String(Math.round(value));

function trendFacts(inputs: QualityInputs): ExplanationFact[] {
  const t = inputs.trend;
  const facts: ExplanationFact[] = [];
  if (t.ema20 !== null && t.ema50 !== null && t.ema200 !== null) {
    facts.push({ label: '1h EMA', value: emaOrderText(t.ema20, t.ema50, t.ema200) });
  }
  if (t.ema50SlopeAtr !== null) {
    facts.push({ label: '1h EMA 50 slope (3 h)', value: `${signedTwo(t.ema50SlopeAtr)} ATR(1h)` });
  }
  if (t.adx !== null) {
    const directional =
      t.plusDI !== null && t.minusDI !== null
        ? `${whole(t.adx)} (+DI ${whole(t.plusDI)} / -DI ${whole(t.minusDI)})`
        : null;
    facts.push({ label: 'ADX(1h)', value: directional ?? Math.round(t.adx) });
  }
  if (t.supertrend !== null) {
    facts.push({ label: 'Supertrend 1h', value: t.supertrend === 'UP' ? 'up' : 'down' });
  }
  return facts;
}

const BREAK_TEXT = { WITH: 'with the trade', NONE: 'none', AGAINST: 'against the trade' } as const;

function structureFacts(inputs: QualityInputs): ExplanationFact[] {
  const s = inputs.structure;
  const facts: ExplanationFact[] = [];
  if (s.state15m !== null || s.state5m !== null) {
    facts.push({
      label: 'Structure 15m / 5m',
      value: `${stateWord(s.state15m)} / ${stateWord(s.state5m)}`,
    });
  }
  if (s.breakEvent !== null)
    facts.push({ label: 'Latest 5m break', value: BREAK_TEXT[s.breakEvent] });
  if (s.sweep !== null) {
    facts.push({
      label: 'Sweep',
      value: `${fixedText(s.sweep.depthAtr, 2)} x ATR deep, wick ${percentText(s.sweep.wickRatio)}`,
    });
  }
  if (s.confluence !== null) {
    facts.push({
      label: 'Trendline and zone confluence',
      value: `${countText(s.confluence)} agree`,
    });
  }
  if (s.patternMoveR !== null)
    facts.push({ label: 'Measured move', value: plainRText(s.patternMoveR) });
  return facts;
}

function triggerFacts(inputs: QualityInputs): ExplanationFact[] {
  const t = inputs.trigger;
  const facts: ExplanationFact[] = [];
  const candle: string[] = [];
  if (t.rangeAtr !== null) candle.push(`range ${atrText(t.rangeAtr)}`);
  if (t.closeLocation !== null)
    candle.push(`closed at ${percentText(t.closeLocation)} of its range`);
  if (candle.length > 0) facts.push({ label: 'Trigger candle', value: candle.join(', ') });
  if (t.rsiNow !== null && t.rsiExtreme !== null) {
    facts.push({ label: 'RSI(5m)', value: `${whole(t.rsiExtreme)} \u2192 ${whole(t.rsiNow)}` });
  }
  if (t.macdBars !== null) {
    const run = countText(Math.abs(t.macdBars));
    facts.push({
      label: 'MACD histogram',
      value:
        t.macdBars > 0
          ? `rising ${run} candles`
          : t.macdBars < 0
            ? `falling ${run} candles`
            : 'flat',
    });
  }
  return facts;
}

const SQUEEZE_TEXT = { RELEASED: 'just released', NONE: 'none', ON: 'still on' } as const;

function volatilityFacts(inputs: QualityInputs, market: MarketNumbers): ExplanationFact[] {
  const v = inputs.volatility;
  const facts: ExplanationFact[] = [{ label: 'ATR(5m)', value: roundTo(market.atr5, 2) }];
  if (v.atrPercentile !== null) {
    facts.push({ label: 'ATR percentile', value: ordinalText(v.atrPercentile) });
  }
  if (v.squeeze !== null) facts.push({ label: 'Squeeze', value: SQUEEZE_TEXT[v.squeeze] });
  return facts;
}

function executionFacts(inputs: QualityInputs, market: MarketNumbers): ExplanationFact[] {
  const e = inputs.execution;
  const facts: ExplanationFact[] = [];
  if (market.spread !== null) facts.push({ label: 'Spread', value: roundTo(market.spread, 3) });
  if (e.spreadPercentile !== null) {
    facts.push({ label: 'Spread percentile', value: ordinalText(e.spreadPercentile) });
  }
  if (e.stopAtr !== null) facts.push({ label: 'Stop distance', value: atrText(e.stopAtr) });
  return facts;
}

function sessionMacroFacts(inputs: QualityInputs): ExplanationFact[] {
  const m = inputs.sessionMacro;
  const facts: ExplanationFact[] = [];
  if (m.session !== null) facts.push({ label: 'Session', value: SESSION_NAMES[m.session] });
  if (m.news !== null) {
    const value =
      m.news.state === 'UNKNOWN'
        ? 'calendar unavailable'
        : m.news.state === 'IN_WINDOW'
          ? 'inside the news window'
          : m.news.minutesToNext === null
            ? 'none known'
            : `in ${spanText(m.news.minutesToNext * 60_000)}`;
    facts.push({ label: 'High-impact USD event', value });
  }
  return facts;
}

function rewardFacts(inputs: QualityInputs): ExplanationFact[] {
  const r = inputs.reward;
  const facts: ExplanationFact[] = [];
  if (r.tp1Atr !== null) facts.push({ label: 'TP1 distance', value: atrText(r.tp1Atr) });
  if (r.levelRoom !== null) {
    facts.push({
      label: 'Room to the next level',
      value:
        r.levelRoom === 'NONE'
          ? 'no level ahead'
          : `${fixedText(r.levelRoom, 1)} x the distance to TP1`,
    });
  }
  return facts;
}

/**
 * The actual numbers behind a group of the quality score: the very facts that were scored, so the
 * "why" of a signal cannot say anything the score did not see. A group with no data has no facts.
 */
export function groupFacts(
  group: QualityGroup,
  inputs: QualityInputs,
  market: MarketNumbers,
): ExplanationFact[] {
  switch (group) {
    case 'trend':
      return trendFacts(inputs);
    case 'structure':
      return structureFacts(inputs);
    case 'trigger':
      return triggerFacts(inputs);
    case 'volatility':
      return volatilityFacts(inputs, market);
    case 'execution':
      return executionFacts(inputs, market);
    case 'sessionMacro':
      return sessionMacroFacts(inputs);
    case 'reward':
      return rewardFacts(inputs);
  }
}

export { stateWord as chartStateText, signedTwo as signedTwoText, whole as wholeText };
