import { describe, expect, it } from 'vitest';

import {
  formatFactor,
  formatInterval,
  formatPercent,
  formatR,
  formatScore,
  matchLevelText,
  signalLabel,
} from './signal';

describe('signalLabel', () => {
  it('pads the number to four digits', () => {
    expect(signalLabel(42)).toBe('S-0042');
    expect(signalLabel(7)).toBe('S-0007');
    expect(signalLabel(12345)).toBe('S-12345');
  });
});

describe('formatR', () => {
  it('always shows the sign and two decimals', () => {
    expect(formatR(0.6)).toBe('+0.60R');
    expect(formatR(-0.2)).toBe('-0.20R');
    expect(formatR(1.47)).toBe('+1.47R');
  });

  it('shows zero without a sign, also for values that round to zero', () => {
    expect(formatR(0)).toBe('0.00R');
    expect(formatR(-0.004)).toBe('0.00R');
  });
});

describe('evidence formatting', () => {
  it('writes whole percentages, ranges and factors', () => {
    expect(formatPercent(0.58)).toBe('58%');
    expect(formatInterval([0.46, 0.69])).toBe('46\u201369%');
    expect(formatFactor(1.5)).toBe('1.50');
    expect(formatScore(78.36)).toBe('78');
  });

  it('names the bucket the evidence was matched on', () => {
    expect(matchLevelText(0)).toBe('strategy, side, session, regime and volatility');
    expect(matchLevelText(2)).toBe('strategy, side and session');
    expect(matchLevelText(4)).toBe('strategy and side, all versions');
  });
});
