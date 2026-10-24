import { describe, expect, it } from 'vitest';

import { NEAR_LEVEL_DEFAULTS, nearOpposingLevel, type NearLevelInput } from './nearLevel';

/** An entry of 4017 with ATR(5m) 4: 0.3 ATR is 1.2 USD. No round number of 50 or 100 is within 30 USD of it. */
const BASE: NearLevelInput = {
  side: 'BUY',
  entry: 4017,
  atr5: 4,
  liquidity: [],
  zones: [],
};

const level = (id: string, price: number) => ({ id, price });
const zone = (id: string, bottom: number, top: number, touches = 3) => ({
  id,
  bottom,
  top,
  touches,
});

describe('liquidity levels', () => {
  it('a level above a BUY entry within 0.3 ATR is in the way, with its distance in ATR', () => {
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('PDH:2026-01-13', 4018)] })).toEqual({
      id: 'PDH:2026-01-13',
      kind: 'LIQUIDITY',
      price: 4018,
      distanceAtr: 0.25,
    });
  });

  it('exactly 0.3 ATR counts, a little more does not', () => {
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('a', 4018.2)] })).not.toBeNull();
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('a', 4018.201)] })).toBeNull();
  });

  it('a level at the entry is in the way (distance 0)', () => {
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('a', 4017)] })).toMatchObject({
      distanceAtr: 0,
    });
  });

  it('a level behind the entry is support, not an obstacle', () => {
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('a', 4016)] })).toBeNull();
    expect(nearOpposingLevel({ ...BASE, liquidity: [level('a', 4016.9)] })).toBeNull();
  });

  it('a SELL is the mirror: the level must be below the entry', () => {
    const sell = { ...BASE, side: 'SELL' as const };
    expect(nearOpposingLevel({ ...sell, liquidity: [level('a', 4016)] })).toMatchObject({
      id: 'a',
      distanceAtr: 0.25,
    });
    expect(nearOpposingLevel({ ...sell, liquidity: [level('a', 4016.8)] })).not.toBeNull();
    expect(nearOpposingLevel({ ...sell, liquidity: [level('a', 4015.79)] })).toBeNull();
    expect(nearOpposingLevel({ ...sell, liquidity: [level('a', 4018)] })).toBeNull();
  });

  it('takes the nearest level, and the smaller id when two are equally near', () => {
    const levels = [level('far', 4018), level('near', 4017.5)];
    expect(nearOpposingLevel({ ...BASE, liquidity: levels })?.id).toBe('near');
    const tie = [level('b', 4018), level('a', 4018)];
    expect(nearOpposingLevel({ ...BASE, liquidity: tie })?.id).toBe('a');
    expect(nearOpposingLevel({ ...BASE, liquidity: [...tie].reverse() })?.id).toBe('a');
  });

  it('leaves out the level that the setup sweeps: it is the reason for the trade', () => {
    const levels = [level('PDL', 4017.5), level('other', 4018)];
    expect(nearOpposingLevel({ ...BASE, liquidity: levels, sweptLevelId: 'PDL' })?.id).toBe(
      'other',
    );
    expect(
      nearOpposingLevel({ ...BASE, liquidity: [level('PDL', 4017.5)], sweptLevelId: 'PDL' }),
    ).toBeNull();
  });
});

describe('zones', () => {
  it('a zone ahead is measured to its near edge', () => {
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4018, 4020)] })).toEqual({
      id: 'Z1',
      kind: 'ZONE',
      price: 4018,
      distanceAtr: 0.25,
    });
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4019, 4021)] })).toBeNull();
  });

  it('an entry inside a zone is as near as it can be', () => {
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4016, 4018)] })).toMatchObject({
      distanceAtr: 0,
      price: 4016,
    });
    expect(
      nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4016, 4018)], side: 'SELL' }),
    ).toMatchObject({ distanceAtr: 0, price: 4018 });
  });

  it('a zone that the entry has left behind is not in the way', () => {
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4014, 4016.9)] })).toBeNull();
    expect(
      nearOpposingLevel({ ...BASE, side: 'SELL', zones: [zone('Z1', 4017.1, 4019)] }),
    ).toBeNull();
  });

  it('an entry exactly on the far edge of a zone is still at the zone', () => {
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4015, 4017)] })).toMatchObject({
      id: 'Z1',
      distanceAtr: 0,
    });
    expect(
      nearOpposingLevel({ ...BASE, side: 'SELL', zones: [zone('Z1', 4017, 4019)] }),
    ).toMatchObject({ id: 'Z1', distanceAtr: 0 });
  });

  it('a SELL measures to the top of a zone below it', () => {
    expect(
      nearOpposingLevel({ ...BASE, side: 'SELL', zones: [zone('Z1', 4014, 4016)] }),
    ).toMatchObject({ id: 'Z1', price: 4016, distanceAtr: 0.25 });
  });

  it('only a zone with 3 swing points or more is major', () => {
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4018, 4020, 2)] })).toBeNull();
    expect(nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4018, 4020, 3)] })).not.toBeNull();
    const loose = { ...NEAR_LEVEL_DEFAULTS, zoneMinTouches: 2 };
    expect(
      nearOpposingLevel({ ...BASE, zones: [zone('Z1', 4018, 4020, 2)] }, loose),
    ).not.toBeNull();
  });
});

describe('round numbers', () => {
  it('a $50 or $100 level just above a BUY entry is in the way', () => {
    expect(nearOpposingLevel({ ...BASE, entry: 4049 })).toEqual({
      id: 'ROUND:4050',
      kind: 'ROUND',
      price: 4050,
      distanceAtr: 0.25,
    });
    expect(nearOpposingLevel({ ...BASE, entry: 4098.9 })).toMatchObject({ id: 'ROUND:4100' });
  });

  it('a level 3 USD away is too far', () => {
    expect(nearOpposingLevel({ ...BASE, entry: 4047 })).toBeNull();
  });

  it('a round number below a SELL entry is in the way, and one above it is not', () => {
    expect(nearOpposingLevel({ ...BASE, side: 'SELL', entry: 4051 })).toMatchObject({
      id: 'ROUND:4050',
    });
    expect(nearOpposingLevel({ ...BASE, side: 'SELL', entry: 4049 })).toBeNull();
  });

  it('an entry on a round number is at distance 0, for both sides', () => {
    expect(nearOpposingLevel({ ...BASE, entry: 4050 })).toMatchObject({ distanceAtr: 0 });
    expect(nearOpposingLevel({ ...BASE, side: 'SELL', entry: 4050 })).toMatchObject({
      distanceAtr: 0,
    });
  });

  it('$10 levels are not major unless the steps say so', () => {
    expect(nearOpposingLevel({ ...BASE, entry: 4009.5 })).toBeNull();
    const tens = { ...NEAR_LEVEL_DEFAULTS, roundSteps: [10] };
    expect(nearOpposingLevel({ ...BASE, entry: 4009.5 }, tens)).toMatchObject({
      id: 'ROUND:4010',
    });
  });
});

describe('the nearest of everything', () => {
  it('compares levels, zones and round numbers by their distance', () => {
    const round = {
      ...BASE,
      entry: 4049,
      liquidity: [level('PDH', 4050.2)],
      zones: [zone('Z1', 4050.1, 4052)],
    };
    expect(nearOpposingLevel(round)?.id).toBe('ROUND:4050');
    const zoneNearest = {
      ...BASE,
      liquidity: [level('PDH', 4018)],
      zones: [zone('Z1', 4017.5, 4019)],
    };
    expect(nearOpposingLevel(zoneNearest)?.id).toBe('Z1');
    const levelNearest = {
      ...BASE,
      liquidity: [level('PDH', 4017.2)],
      zones: [zone('Z1', 4017.5, 4019)],
    };
    expect(nearOpposingLevel(levelNearest)?.id).toBe('PDH');
  });
});

describe('the limits', () => {
  it('cannot judge without an ATR', () => {
    const input = { ...BASE, liquidity: [level('a', 4017.5)] };
    expect(nearOpposingLevel({ ...input, atr5: null })).toBeNull();
    expect(nearOpposingLevel({ ...input, atr5: 0 })).toBeNull();
    expect(nearOpposingLevel({ ...input, atr5: -1 })).toBeNull();
    // even a level right at the entry says nothing without a usable ATR
    const atEntry = { ...BASE, liquidity: [level('a', 4017)] };
    expect(nearOpposingLevel({ ...atEntry, atr5: 0 })).toBeNull();
  });

  it('exactly 0.3 ATR counts even when the binary subtraction is a hair above it', () => {
    // 4001.3 - 4000.1 is 1.2000000000002728 in binary arithmetic: 0.3 x 4 is 1.2
    const input = { ...BASE, entry: 4000.1, liquidity: [level('a', 4001.3)] };
    expect(nearOpposingLevel(input)).toMatchObject({ id: 'a' });
  });

  it('takes the distance from the parameters', () => {
    const wide = { ...NEAR_LEVEL_DEFAULTS, distanceAtr: 0.5 };
    const input = { ...BASE, liquidity: [level('a', 4019)] };
    expect(nearOpposingLevel(input)).toBeNull();
    expect(nearOpposingLevel(input, wide)).toMatchObject({ id: 'a', distanceAtr: 0.5 });
  });

  it('has the defaults of docs/02 section 6.1', () => {
    expect(NEAR_LEVEL_DEFAULTS).toEqual({
      distanceAtr: 0.3,
      roundSteps: [50, 100],
      zoneMinTouches: 3,
    });
  });

  it('refuses an entry that is not a number', () => {
    expect(() => nearOpposingLevel({ ...BASE, entry: Number.NaN })).toThrow(/entry/);
  });
});
