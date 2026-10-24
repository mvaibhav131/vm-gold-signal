import { CAUSE_CODES, CAUSE_CATEGORIES, RESULTS, SIGNAL_EVENT_TYPES } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_LABELS,
  CATEGORY_TONE,
  CAUSE_LABELS,
  CAUSE_RULES,
  EVENT_LABELS,
  EXIT_PROFILE_TEXT,
  RESULT_LABELS,
  exitReasonText,
  formatFactor,
  formatInterval,
  formatPercent,
  formatR,
  formatScore,
  humanizeKey,
  matchLevelText,
  rClass,
  resultChip,
  signalLabel,
  winRateText,
} from './signal';
import { formatDuration } from './time';

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

describe('winRateText', () => {
  it('shows a percentage with its interval from 30 valid results', () => {
    expect(winRateText({ resolvedValid: 39, winRate: 0.538, ci95: [0.385, 0.684] })).toBe(
      '54% (95% CI 39\u201368%)',
    );
  });

  it('shows only the count when either the rate or its interval is missing, never a half-made percentage', () => {
    expect(winRateText({ resolvedValid: 40, winRate: 0.5, ci95: null })).toBe(
      'Insufficient evidence (40 results)',
    );
    expect(winRateText({ resolvedValid: 40, winRate: null, ci95: [0.3, 0.7] })).toBe(
      'Insufficient evidence (40 results)',
    );
  });

  it('shows only the count below 30 valid results (rule C6)', () => {
    expect(winRateText({ resolvedValid: 12, winRate: null, ci95: null })).toBe(
      'Insufficient evidence (12 results)',
    );
    expect(winRateText({ resolvedValid: 0, winRate: null, ci95: null })).toBe(
      'Insufficient evidence (0 results)',
    );
  });
});

describe('resultChip', () => {
  it('colours wins green, losses red and the rest neutral, always with the words', () => {
    expect(resultChip('WIN', 'CLOSED')).toEqual({ text: 'Win', tone: 'positive' });
    expect(resultChip('PARTIAL_WIN', 'CLOSED')).toEqual({ text: 'Partial win', tone: 'positive' });
    expect(resultChip('LOSS', 'CLOSED')).toEqual({ text: 'Loss', tone: 'negative' });
    for (const result of ['TIME_EXIT', 'CANCELLED', 'DATA_INVALID'] as const) {
      expect(resultChip(result, 'CLOSED').tone).toBe('neutral');
    }
  });

  it('says that an open signal is open, and whether TP1 was hit', () => {
    expect(resultChip(null, 'ACTIVE')).toEqual({ text: 'Open', tone: 'info' });
    expect(resultChip(null, 'TP1_HIT')).toEqual({ text: 'Open (TP1 hit)', tone: 'info' });
  });
});

describe('the words of the review and of the timeline', () => {
  it('has a label, a rule and a category for every cause code, and a label for every category', () => {
    for (const code of CAUSE_CODES) {
      expect(CAUSE_LABELS[code], code).toBeTruthy();
      expect(CAUSE_RULES[code], code).toMatch(/\.$/);
    }
    for (const category of CAUSE_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
      expect(CATEGORY_TONE[category], category).toBeTruthy();
    }
  });

  it('has a label for every result and every kind of event', () => {
    for (const result of RESULTS) expect(RESULT_LABELS[result], result).toBeTruthy();
    for (const type of SIGNAL_EVENT_TYPES) expect(EVENT_LABELS[type], type).toBeTruthy();
  });

  it('explains the exit profiles and the known exit reasons, and passes an unknown reason through', () => {
    expect(EXIT_PROFILE_TEXT.EP1_PARTIAL).toContain('50% at TP1');
    expect(exitReasonText('SL')).toBe('Stop loss');
    expect(exitReasonText('TIME_STOP')).toBe('Time stop');
    expect(exitReasonText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('turns the names of the numbers behind a cause into words', () => {
    expect(humanizeKey('maxFavourableR')).toBe('max favourable R');
    expect(humanizeKey('candlesToTp1AfterStop')).toBe('candles to TP1 after stop');
    expect(humanizeKey('adverseMoveAtr')).toBe('adverse move ATR');
    expect(humanizeKey('shareOfRisk')).toBe('share of risk');
    expect(humanizeKey('limit')).toBe('limit');
  });
});

describe('rClass and durations', () => {
  it('colours a signed R value and leaves zero plain', () => {
    expect(rClass(0.4)).toBe('text-positive');
    expect(rClass(-0.4)).toBe('text-negative');
    expect(rClass(0)).toBeUndefined();
  });

  it('writes how long a trade lasted', () => {
    expect(formatDuration(15 * 60)).toBe('15 min');
    expect(formatDuration(74 * 60)).toBe('1 h 14 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(45)).toBe('45 s');
  });
});
