import { describe, expect, it } from 'vitest';

import { breakdownKeyLabel, sentenceCase, titleCase } from './labels';
import { monthText } from './MonthlyTable';
import { scopeFromParams, withScope } from './scope';

describe('the scope in the address bar', () => {
  it('is forward by default, and for a value it does not know', () => {
    expect(scopeFromParams(new URLSearchParams(''))).toBe('FORWARD');
    expect(scopeFromParams(new URLSearchParams('scope=LIVE'))).toBe('FORWARD');
    expect(scopeFromParams(new URLSearchParams('scope=backtest_oos'))).toBe('FORWARD');
    expect(scopeFromParams(new URLSearchParams('scope='))).toBe('FORWARD');
  });

  it('reads the backtest', () => {
    expect(scopeFromParams(new URLSearchParams('scope=BACKTEST_OOS'))).toBe('BACKTEST_OOS');
    expect(scopeFromParams(new URLSearchParams('x=1&scope=FORWARD'))).toBe('FORWARD');
  });

  it('writes the backtest and leaves the forward default out, keeping other parameters', () => {
    const base = new URLSearchParams('x=1');
    expect(withScope(base, 'BACKTEST_OOS').toString()).toBe('x=1&scope=BACKTEST_OOS');
    expect(withScope(new URLSearchParams('x=1&scope=BACKTEST_OOS'), 'FORWARD').toString()).toBe(
      'x=1',
    );
    // the parameters it was given are not changed
    expect(base.toString()).toBe('x=1');
  });
});

describe('labels', () => {
  it('turns a code into a sentence, and a session into a name', () => {
    expect(sentenceCase('NEW_YORK')).toBe('New york');
    expect(sentenceCase('TREND_UP')).toBe('Trend up');
    expect(sentenceCase('IN_WINDOW')).toBe('In window');
    expect(titleCase('NEW_YORK')).toBe('New York');
    expect(titleCase('ASIA')).toBe('Asia');
  });

  it('names a strategy, and leaves BUY, SELL and the grade names as they are', () => {
    expect(breakdownKeyLabel('strategy', 'squeeze_retest')).toBe('Squeeze Breakout and Retest');
    expect(breakdownKeyLabel('strategy', 'unknown_one')).toBe('unknown_one');
    expect(breakdownKeyLabel('side', 'BUY')).toBe('BUY');
    expect(breakdownKeyLabel('grade', 'Strong')).toBe('Strong');
    expect(breakdownKeyLabel('session', 'NEW_YORK')).toBe('New York');
    expect(breakdownKeyLabel('volatility', 'HIGH')).toBe('High');
  });

  it('writes a month with its name', () => {
    expect(monthText('2026-07')).toBe('Jul 2026');
    expect(monthText('2025-12')).toBe('Dec 2025');
    expect(monthText('2026-01')).toBe('Jan 2026');
  });
});
