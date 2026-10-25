import { describe, expect, it } from 'vitest';

import { ADVISORY_FLAGS } from '../domain';
import { flagOf } from './test-data';
import { warningText, warningsOf } from './warnings';

describe('news window', () => {
  const text = (detail: Record<string, string | number | boolean | null>, eventName?: string) =>
    warningText(flagOf('NEWS_WINDOW', detail), eventName === undefined ? {} : { eventName });

  it('says what event, and when', () => {
    expect(text({ minutesToEvent: 22, settling: false }, 'CPI m/m')).toBe(
      'News window: CPI m/m in 22 min',
    );
    expect(text({ minutesToEvent: -15, settling: false }, 'CPI m/m')).toBe(
      'News window: CPI m/m was 15 min ago',
    );
    expect(text({ minutesToEvent: 95, settling: false }, 'NFP')).toBe(
      'News window: NFP in 1 h 35 min',
    );
  });

  it('says that the volatility is still settling', () => {
    expect(text({ minutesToEvent: -40, settling: true }, 'CPI m/m')).toBe(
      'News window: CPI m/m was 40 min ago (volatility is still settling)',
    );
    expect(text({ minutesToEvent: 20, settling: true }, 'CPI m/m')).toBe(
      'News window: CPI m/m in 20 min (volatility is still settling)',
    );
  });

  it('counts an event that is exactly now as still to come', () => {
    expect(text({ minutesToEvent: 0, settling: false }, 'CPI m/m')).toBe(
      'News window: CPI m/m in 0 s',
    );
  });

  it('does not need the name or the time', () => {
    expect(text({ minutesToEvent: null, settling: false })).toBe(
      'News window: a high-impact event',
    );
    expect(text({ minutesToEvent: 5, settling: false })).toBe(
      'News window: a high-impact event in 5 min',
    );
    expect(warningText(flagOf('NEWS_WINDOW'), { eventName: null })).toBe(
      'News window: a high-impact event',
    );
  });
});

describe('the other flags', () => {
  it('news shock names the ratios that are known', () => {
    expect(warningText(flagOf('NEWS_SHOCK', { atrRatio: 2.6, spreadRatio: 1.2 }))).toBe(
      'News shock: ATR 2.6 x its 24 h median, spread 1.2 x its 24 h median',
    );
    expect(warningText(flagOf('NEWS_SHOCK', { atrRatio: 2.55, spreadRatio: null }))).toBe(
      'News shock: ATR 2.6 x its 24 h median',
    );
    expect(warningText(flagOf('NEWS_SHOCK', { atrRatio: null, spreadRatio: 3 }))).toBe(
      'News shock: spread 3.0 x its 24 h median',
    );
    expect(warningText(flagOf('NEWS_SHOCK'))).toBe('News shock: volatility jumped');
  });

  it('a recent headline says how long ago', () => {
    expect(warningText(flagOf('HEADLINE_RECENT', { minutesAgo: 12 }))).toBe(
      'A HIGH-impact headline was published 12 min ago',
    );
    expect(warningText(flagOf('HEADLINE_RECENT', { minutesAgo: 0 }))).toBe(
      'A HIGH-impact headline was published 0 s ago',
    );
    expect(warningText(flagOf('HEADLINE_RECENT'))).toBe(
      'A HIGH-impact headline was published recently',
    );
  });

  it('rollover and off hours', () => {
    expect(warningText(flagOf('ROLLOVER', { session: 'ROLLOVER' }))).toBe(
      'Rollover hours: liquidity is thin and spreads can be wide',
    );
    expect(warningText(flagOf('OFF_HOURS', { session: 'ASIA', minutesToClose: null }))).toBe(
      'Off hours: the Asia session is quiet',
    );
    expect(warningText(flagOf('OFF_HOURS', { session: 'NEW_YORK', minutesToClose: 20 }))).toBe(
      'Off hours: London and New York are about to close',
    );
  });

  it('a level close to the entry names its kind, price and distance', () => {
    expect(
      warningText(
        flagOf('NEAR_LEVEL', {
          levelId: 'rn-4020',
          kind: 'ROUND_NUMBER',
          price: 4020,
          distanceAtr: 0.44,
        }),
      ),
    ).toBe('Near a major round number at 4020.000 (0.4 x ATR away)');
    expect(warningText(flagOf('NEAR_LEVEL'))).toBe('Near a major level');
  });

  it('an open signal on the other side is named when its number is known', () => {
    const opposes = flagOf('OPPOSES_OPEN', { signalIds: ['a', 'b'] });
    expect(warningText(opposes, { openLabels: { a: '#S-0041' } })).toBe(
      'Opposes open signal #S-0041',
    );
    expect(warningText(opposes, { openLabels: { a: '#S-0041', b: '#S-0042' } })).toBe(
      'Opposes open signals #S-0041, #S-0042',
    );
    expect(warningText(opposes)).toBe('Opposes 2 open signals');
    expect(warningText(flagOf('OPPOSES_OPEN', { signalIds: ['a'] }))).toBe('Opposes 1 open signal');
  });

  it('an unvalidated strategy and an unknown calendar', () => {
    expect(warningText(flagOf('UNVALIDATED_STRATEGY', { status: 'FORWARD_TESTING' }))).toBe(
      'FORWARD-TEST: this strategy is not validated yet (paper signal)',
    );
    expect(warningText(flagOf('NEWS_UNKNOWN', { reason: 'calendar feed unavailable' }))).toBe(
      'News calendar unavailable: news risk is not known',
    );
  });

  it('has words for every flag', () => {
    for (const flag of ADVISORY_FLAGS) {
      expect(warningText(flagOf(flag)).length, flag).toBeGreaterThan(10);
    }
  });
});

describe('warningsOf', () => {
  it('keeps the flags that are present, in the order they came', () => {
    const warnings = warningsOf([
      flagOf('NEWS_WINDOW', { minutesToEvent: 10, settling: false }, false),
      flagOf('ROLLOVER', { session: 'ROLLOVER' }),
      flagOf('NEWS_UNKNOWN'),
      flagOf('UNVALIDATED_STRATEGY', {}, false),
    ]);
    expect(warnings).toEqual([
      { code: 'ROLLOVER', text: 'Rollover hours: liquidity is thin and spreads can be wide' },
      { code: 'NEWS_UNKNOWN', text: 'News calendar unavailable: news risk is not known' },
    ]);
  });

  it('is empty with no flag', () => {
    expect(warningsOf([])).toEqual([]);
    expect(warningsOf([flagOf('ROLLOVER', {}, false)])).toEqual([]);
  });

  it('passes the context on', () => {
    expect(
      warningsOf([flagOf('NEWS_WINDOW', { minutesToEvent: 30, settling: false })], {
        eventName: 'FOMC',
      }),
    ).toEqual([{ code: 'NEWS_WINDOW', text: 'News window: FOMC in 30 min' }]);
  });
});
