import { describe, expect, it } from 'vitest';

import * as domain from './domain';

describe('domain vocabularies', () => {
  it('has no duplicate values in any tuple', () => {
    for (const [name, value] of Object.entries(domain)) {
      if (!Array.isArray(value)) continue;
      expect(new Set(value).size, name).toBe(value.length);
    }
  });

  it('has one strategy per doc strategy (A to F)', () => {
    expect(domain.STRATEGY_KEYS).toHaveLength(6);
  });

  it('retires the hourly paper strategy: its key stays (old signals read), but it is not active', () => {
    expect(domain.RETIRED_STRATEGY_KEYS).toEqual(['hourly_trend']);
    expect(domain.ACTIVE_STRATEGY_KEYS).toEqual([
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
      'trendline_retest',
      'pattern_breakout',
    ]);
    expect(domain.isRetiredStrategy('hourly_trend')).toBe(true);
    expect(domain.isRetiredStrategy('trend_pullback')).toBe(false);
    for (const key of domain.RETIRED_STRATEGY_KEYS) expect(domain.STRATEGY_KEYS).toContain(key);
  });

  it('has the nine blocking gates of the signal engine', () => {
    expect(domain.GATE_CODES).toHaveLength(9);
  });

  it('has the seven quality groups whose weights are defined in the config', () => {
    expect(domain.QUALITY_GROUPS).toHaveLength(7);
  });

  it('gives every cause code a category, and the market-event and execution ones are the external and cost causes', () => {
    expect(Object.keys(domain.CAUSE_CATEGORY_OF).sort()).toEqual([...domain.CAUSE_CODES].sort());
    for (const code of domain.CAUSE_CODES) {
      expect(domain.CAUSE_CATEGORIES).toContain(domain.causeCategory(code));
    }
    expect(domain.causeCategory('NEWS_SHOCK')).toBe('MARKET_EVENT');
    expect(domain.causeCategory('REGIME_SHIFT')).toBe('MARKET_EVENT');
    expect(domain.causeCategory('LIQUIDITY_DROP')).toBe('MARKET_EVENT');
    expect(domain.causeCategory('SPREAD_COST')).toBe('EXECUTION');
    expect(domain.causeCategory('NO_FOLLOW_THROUGH')).toBe('SETUP_FAILURE');
  });
});
