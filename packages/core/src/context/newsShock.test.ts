import { describe, expect, it } from 'vitest';

import { NEWS_SHOCK_DEFAULTS, newsShockOf, ratioOf, type NewsShockInputs } from './newsShock';

const SHOCK: NewsShockInputs = {
  inWindow: true,
  atr5m: 5,
  atrBaseline: 2,
  spread: 0.2,
  spreadBaseline: 0.2,
};

describe('ratioOf', () => {
  it('the value over its baseline', () => {
    expect(ratioOf(5, 2)).toBe(2.5);
    expect(ratioOf(0, 2)).toBe(0);
  });

  it('is null when anything is unknown or the baseline is not above zero', () => {
    expect(ratioOf(null, 2)).toBeNull();
    expect(ratioOf(5, null)).toBeNull();
    expect(ratioOf(5, 0)).toBeNull();
    expect(ratioOf(5, -1)).toBeNull();
    expect(ratioOf(5, Number.NaN)).toBeNull();
  });
});

describe('the NEWS_SHOCK flag', () => {
  it('has the limits of docs/02 section 5: ATR 2.5 times its median, spread 3 times', () => {
    expect(NEWS_SHOCK_DEFAULTS).toEqual({ atrRatio: 2.5, spreadRatio: 3 });
  });

  it('is raised in the news window when ATR(5m) reaches 2.5 times its median', () => {
    expect(newsShockOf(SHOCK)).toEqual({
      active: true,
      atrRatio: 2.5,
      spreadRatio: 1,
      atrExceeds: true,
      spreadExceeds: false,
    });
    expect(newsShockOf({ ...SHOCK, atr5m: 4.99 }).active).toBe(false);
  });

  it('is raised in the news window when the spread reaches 3 times its median', () => {
    const wide = { ...SHOCK, atr5m: 2, spread: 1.5, spreadBaseline: 0.5 };
    expect(newsShockOf(wide)).toMatchObject({ active: true, spreadRatio: 3, spreadExceeds: true });
    expect(newsShockOf({ ...wide, spread: 1.49 }).active).toBe(false);
  });

  it('is raised by either, and by both', () => {
    const both = { ...SHOCK, spread: 2, spreadBaseline: 0.5 };
    expect(newsShockOf(both)).toMatchObject({
      active: true,
      atrExceeds: true,
      spreadExceeds: true,
    });
  });

  it('is not raised outside the news window, however wild the market is, but the ratios are still reported', () => {
    const result = newsShockOf({ ...SHOCK, inWindow: false });
    expect(result.active).toBe(false);
    expect(result).toMatchObject({ atrRatio: 2.5, atrExceeds: true });
  });

  it('is not raised on a calm market inside the window', () => {
    expect(newsShockOf({ ...SHOCK, atr5m: 2 })).toMatchObject({ active: false, atrRatio: 1 });
  });

  it('cannot be raised by missing data', () => {
    expect(newsShockOf({ ...SHOCK, atr5m: null }).active).toBe(false);
    expect(newsShockOf({ ...SHOCK, atrBaseline: null }).active).toBe(false);
    expect(newsShockOf({ ...SHOCK, atrBaseline: 0 }).active).toBe(false);
    const spreadOnly = { ...SHOCK, atr5m: null, spread: 3, spreadBaseline: 1 };
    expect(newsShockOf(spreadOnly)).toMatchObject({ active: true, atrRatio: null });
    expect(newsShockOf({ ...spreadOnly, spread: null })).toMatchObject({
      active: false,
      spreadRatio: null,
    });
    expect(newsShockOf({ ...spreadOnly, spreadBaseline: null }).active).toBe(false);
  });

  it('takes its limits from the parameters', () => {
    const strict = { atrRatio: 6, spreadRatio: 10 };
    expect(newsShockOf(SHOCK, strict).active).toBe(false);
    expect(newsShockOf({ ...SHOCK, atr5m: 12 }, strict).active).toBe(true);
    expect(newsShockOf({ ...SHOCK, atr5m: 2, spread: 2, spreadBaseline: 0.2 }, strict).active).toBe(
      true,
    );
  });
});
