import { describe, expect, it } from 'vitest';

import { macroProximity, type MacroEventInput, type NewsWindowSpec } from '../context/macro';
import { newsShockOf } from '../context/newsShock';
import { ADVISORY_FLAGS, STRATEGY_STATUSES, type AdvisoryFlag } from '../domain';
import { evaluateGates } from './blocking';
import {
  ADVISORY_SWITCHES,
  DEFAULT_MODES,
  FLAG_DEFAULTS,
  FLAG_SWITCH,
  decide,
  evaluateFlags,
  modeOf,
  resolveModes,
  type AdvisoryModes,
  type FlagMarketInputs,
  type FlagResult,
  type FlagSetupInputs,
} from './flags';
import { MARKET_OK, NOW, SETUP_OK } from './test-data';

const MIN = 60_000;
const SPEC: NewsWindowSpec = { before: 45, after: 20, impact: ['high'], currency: ['USD'] };
const utc = (iso: string) => Date.parse(iso);

const event = (id: string, minutes: number, at = NOW): MacroEventInput => ({
  id,
  scheduledAt: at + minutes * MIN,
  importance: 'high',
  currency: 'USD',
});

/** A quiet market at 14:00 UTC (the overlap): no event, no shock, no headline, calendar available. */
const QUIET: FlagMarketInputs = {
  now: NOW,
  calendar: macroProximity([], NOW, SPEC),
  newsShock: null,
  lastHighHeadlineAt: null,
};

const SETUP: FlagSetupInputs = {
  side: 'BUY',
  strategyStatus: 'VALIDATED',
  nearLevel: null,
  openSignals: [],
};

const presentFlags = (results: readonly FlagResult[]): AdvisoryFlag[] =>
  results.filter((r) => r.present).map((r) => r.flag);

const flagsAt = (iso: string, change: Partial<FlagMarketInputs> = {}) => {
  const now = utc(iso);
  return evaluateFlags({ ...QUIET, now, calendar: macroProximity([], now, SPEC), ...change }, null);
};

describe('the list of flags', () => {
  it('has all nine flags in the order of ADVISORY_FLAGS, with nothing present in a quiet market', () => {
    const results = evaluateFlags(QUIET, SETUP);
    expect(results.map((r) => r.flag)).toEqual([...ADVISORY_FLAGS]);
    expect(presentFlags(results)).toEqual([]);
    expect(results.every((r) => Object.keys(r.detail).length === 0)).toBe(true);
  });

  it('without a setup the three setup flags are never present', () => {
    const results = evaluateFlags(QUIET, null);
    expect(results).toHaveLength(9);
    const noisy = evaluateFlags({ ...QUIET, calendar: null }, null);
    expect(presentFlags(noisy)).toEqual(['NEWS_UNKNOWN']);
  });

  it('refuses a time that is not a number', () => {
    expect(() => evaluateFlags({ ...QUIET, now: Number.NaN }, null)).toThrow(/now/);
  });
});

describe('NEWS_WINDOW', () => {
  const at = (minutes: number, calm?: { atrRatio: number | null; spreadRatio: number | null }) =>
    evaluateFlags(
      { ...QUIET, calendar: macroProximity([event('cpi', minutes)], NOW, SPEC, calm) },
      null,
    ).find((r) => r.flag === 'NEWS_WINDOW');

  it('is present from 45 minutes before a high USD event, with the event and the minutes to it', () => {
    expect(at(45)).toEqual({
      flag: 'NEWS_WINDOW',
      present: true,
      detail: { eventId: 'cpi', minutesToEvent: 45, settling: false },
    });
    expect(at(46)?.present).toBe(false);
  });

  it('is present until 20 minutes after it', () => {
    expect(at(-20)).toMatchObject({ present: true, detail: { minutesToEvent: -20 } });
    expect(at(-21)?.present).toBe(false);
  });

  it('stays present while spread or ATR have not settled, and says so', () => {
    const result = at(-60, { atrRatio: 1.6, spreadRatio: 1 });
    expect(result).toEqual({
      flag: 'NEWS_WINDOW',
      present: true,
      detail: { eventId: 'cpi', minutesToEvent: null, settling: true },
    });
    expect(at(-60, { atrRatio: 1.2, spreadRatio: 1.2 })?.present).toBe(false);
  });

  it('is not present when the calendar is unavailable (NEWS_UNKNOWN is)', () => {
    const results = evaluateFlags({ ...QUIET, calendar: null }, null);
    expect(results.find((r) => r.flag === 'NEWS_WINDOW')?.present).toBe(false);
  });
});

describe('NEWS_SHOCK', () => {
  const shock = (atr5m: number, inWindow = true) =>
    newsShockOf({ inWindow, atr5m, atrBaseline: 2, spread: 0.2, spreadBaseline: 0.2 });

  it('is present when the shock is active, with the two ratios', () => {
    const result = evaluateFlags({ ...QUIET, newsShock: shock(6) }, null).find(
      (r) => r.flag === 'NEWS_SHOCK',
    );
    expect(result).toEqual({
      flag: 'NEWS_SHOCK',
      present: true,
      detail: { atrRatio: 3, spreadRatio: 1 },
    });
  });

  it('is not present when it is not active or cannot be judged', () => {
    expect(presentFlags(evaluateFlags({ ...QUIET, newsShock: shock(3) }, null))).toEqual([]);
    expect(presentFlags(evaluateFlags({ ...QUIET, newsShock: shock(6, false) }, null))).toEqual([]);
    expect(presentFlags(evaluateFlags({ ...QUIET, newsShock: null }, null))).toEqual([]);
  });
});

describe('HEADLINE_RECENT', () => {
  const headline = (minutesAgo: number | null) =>
    evaluateFlags(
      { ...QUIET, lastHighHeadlineAt: minutesAgo === null ? null : NOW - minutesAgo * MIN },
      null,
    ).find((r) => r.flag === 'HEADLINE_RECENT');

  it('is present for a high headline of the last 30 minutes, with its age', () => {
    expect(headline(10)).toEqual({
      flag: 'HEADLINE_RECENT',
      present: true,
      detail: { minutesAgo: 10 },
    });
    expect(headline(30)?.present).toBe(true);
  });

  it('is not present for an older headline, or none', () => {
    expect(headline(30.01)?.present).toBe(false);
    expect(headline(120)?.present).toBe(false);
    expect(headline(null)?.present).toBe(false);
  });

  it('a headline stamped a little ahead of our clock counts as just now', () => {
    expect(headline(-2)).toMatchObject({ present: true, detail: { minutesAgo: 0 } });
  });

  it('takes the window from the parameters', () => {
    const results = evaluateFlags({ ...QUIET, lastHighHeadlineAt: NOW - 20 * MIN }, null, {
      ...FLAG_DEFAULTS,
      headlineMinutes: 15,
    });
    expect(results.find((r) => r.flag === 'HEADLINE_RECENT')?.present).toBe(false);
  });
});

describe('ROLLOVER', () => {
  const rollover = (iso: string) => flagsAt(iso).find((r) => r.flag === 'ROLLOVER');

  it('is present in the ROLLOVER session, with the session', () => {
    expect(rollover('2026-01-14T22:30:00Z')).toEqual({
      flag: 'ROLLOVER',
      present: true,
      detail: { session: 'ROLLOVER' },
    });
  });

  it('starts at 21:45 UTC and covers the quiet hours up to midnight (the session label)', () => {
    expect(rollover('2026-01-14T21:44:00Z')?.present).toBe(false);
    expect(rollover('2026-01-14T21:45:00Z')?.present).toBe(true);
    expect(rollover('2026-01-14T23:30:00Z')?.present).toBe(true);
    expect(rollover('2026-01-15T00:00:00Z')?.present).toBe(false);
  });

  it('in summer it starts when New York closes, at 21:00 UTC', () => {
    expect(rollover('2026-07-15T21:10:00Z')?.present).toBe(true);
    expect(rollover('2026-07-15T20:59:00Z')?.present).toBe(false);
  });

  it('is not present in the sessions of the day', () => {
    for (const time of ['03:00', '09:00', '14:00', '18:00']) {
      expect(rollover(`2026-01-14T${time}:00Z`)?.present, time).toBe(false);
    }
  });
});

describe('OFF_HOURS', () => {
  const offHours = (iso: string) => flagsAt(iso).find((r) => r.flag === 'OFF_HOURS');

  it('is present in the Asian session, with no open venue', () => {
    expect(offHours('2026-01-14T03:00:00Z')).toEqual({
      flag: 'OFF_HOURS',
      present: true,
      detail: { session: 'ASIA', minutesToClose: null },
    });
  });

  it('is present in the last 30 minutes of the New York session (it closes at 22:00 UTC in winter)', () => {
    expect(offHours('2026-01-14T21:30:00Z')).toEqual({
      flag: 'OFF_HOURS',
      present: true,
      detail: { session: 'NEW_YORK', minutesToClose: 30 },
    });
    expect(offHours('2026-01-14T21:29:00Z')?.present).toBe(false);
  });

  it('follows New York to its summer close at 21:00 UTC', () => {
    expect(offHours('2026-07-15T20:30:00Z')?.present).toBe(true);
    expect(offHours('2026-07-15T20:29:00Z')?.present).toBe(false);
  });

  it('is also present when the rollover starts while New York is still open', () => {
    expect(offHours('2026-01-14T21:50:00Z')).toMatchObject({
      present: true,
      detail: { session: 'ROLLOVER', minutesToClose: 10 },
    });
  });

  it('is not present in the last 30 minutes of London while New York is open: liquidity stays deep', () => {
    expect(offHours('2026-01-14T16:15:00Z')?.present).toBe(false);
  });

  it('is not present in the middle of London, the overlap or New York', () => {
    for (const time of ['08:30', '10:00', '12:30', '14:00', '17:00']) {
      expect(offHours(`2026-01-14T${time}:00Z`)?.present, time).toBe(false);
    }
  });

  it('is not present at the weekend: no venue is open and it is not Asia', () => {
    expect(offHours('2026-01-17T10:00:00Z')?.present).toBe(false);
  });

  it('takes the number of minutes from the parameters', () => {
    const now = utc('2026-01-14T21:10:00Z');
    const flags = (minutes: number) =>
      evaluateFlags({ ...QUIET, now, calendar: macroProximity([], now, SPEC) }, null, {
        ...FLAG_DEFAULTS,
        offHoursMinutes: minutes,
      }).find((r) => r.flag === 'OFF_HOURS');
    expect(flags(30)?.present).toBe(false);
    expect(flags(50)?.present).toBe(true);
  });
});

describe('NEAR_LEVEL', () => {
  const near = { id: 'PDH:2026-01-13', kind: 'LIQUIDITY', price: 4018, distanceAtr: 0.25 } as const;

  it('is present when the setup has a major opposing level near its entry, with the level', () => {
    const result = evaluateFlags(QUIET, { ...SETUP, nearLevel: near }).find(
      (r) => r.flag === 'NEAR_LEVEL',
    );
    expect(result).toEqual({
      flag: 'NEAR_LEVEL',
      present: true,
      detail: { levelId: 'PDH:2026-01-13', kind: 'LIQUIDITY', price: 4018, distanceAtr: 0.25 },
    });
  });

  it('is not present without such a level, or without a setup', () => {
    expect(presentFlags(evaluateFlags(QUIET, SETUP))).toEqual([]);
    expect(presentFlags(evaluateFlags(QUIET, null))).toEqual([]);
  });
});

describe('OPPOSES_OPEN', () => {
  const open = (...sides: ('BUY' | 'SELL')[]) =>
    sides.map((side, i) => ({ id: `S-${String(i + 1)}`, side }));
  const result = (setup: FlagSetupInputs) =>
    evaluateFlags(QUIET, setup).find((r) => r.flag === 'OPPOSES_OPEN');

  it('is present when an open signal goes the other way, naming it', () => {
    expect(result({ ...SETUP, openSignals: open('SELL') })).toEqual({
      flag: 'OPPOSES_OPEN',
      present: true,
      detail: { signalIds: ['S-1'] },
    });
  });

  it('names every opposing signal and none that goes the same way', () => {
    expect(result({ ...SETUP, openSignals: open('BUY', 'SELL', 'SELL') })?.detail).toEqual({
      signalIds: ['S-2', 'S-3'],
    });
  });

  it('is not present when every open signal goes the same way, or there is none', () => {
    expect(result({ ...SETUP, openSignals: open('BUY', 'BUY') })?.present).toBe(false);
    expect(result({ ...SETUP, openSignals: [] })?.present).toBe(false);
  });

  it('is judged against the side of the setup', () => {
    expect(result({ ...SETUP, side: 'SELL', openSignals: open('BUY') })?.present).toBe(true);
    expect(result({ ...SETUP, side: 'SELL', openSignals: open('SELL') })?.present).toBe(false);
  });
});

describe('UNVALIDATED_STRATEGY', () => {
  it.each(STRATEGY_STATUSES)('%s', (status) => {
    const result = evaluateFlags(QUIET, { ...SETUP, strategyStatus: status }).find(
      (r) => r.flag === 'UNVALIDATED_STRATEGY',
    );
    if (status === 'VALIDATED') {
      expect(result).toEqual({ flag: 'UNVALIDATED_STRATEGY', present: false, detail: {} });
    } else {
      expect(result).toEqual({
        flag: 'UNVALIDATED_STRATEGY',
        present: true,
        detail: { status },
      });
    }
  });
});

describe('NEWS_UNKNOWN', () => {
  it('is present when the calendar feed is unavailable', () => {
    const result = evaluateFlags({ ...QUIET, calendar: null }, null).find(
      (r) => r.flag === 'NEWS_UNKNOWN',
    );
    expect(result).toEqual({
      flag: 'NEWS_UNKNOWN',
      present: true,
      detail: { reason: 'calendar feed unavailable' },
    });
  });

  it('is not present when it is available, whether or not an event is near', () => {
    expect(presentFlags(evaluateFlags(QUIET, null))).toEqual([]);
    const calendar = macroProximity([event('cpi', 10)], NOW, SPEC);
    expect(presentFlags(evaluateFlags({ ...QUIET, calendar }, null))).toEqual(['NEWS_WINDOW']);
  });
});

describe('the owner switches', () => {
  it('are four, the ones of the settings', () => {
    expect(ADVISORY_SWITCHES).toEqual(['newsWindow', 'rollover', 'offHours', 'nearLevel']);
    expect(FLAG_SWITCH).toEqual({
      NEWS_WINDOW: 'newsWindow',
      ROLLOVER: 'rollover',
      OFF_HOURS: 'offHours',
      NEAR_LEVEL: 'nearLevel',
    });
  });

  it('start as warn for every flag', () => {
    expect(DEFAULT_MODES).toEqual({
      newsWindow: 'warn',
      rollover: 'warn',
      offHours: 'warn',
      nearLevel: 'warn',
    });
    for (const flag of ADVISORY_FLAGS) expect(modeOf(flag, DEFAULT_MODES)).toBe('warn');
  });

  it('give a flag the mode of its switch', () => {
    const modes: AdvisoryModes = { ...DEFAULT_MODES, rollover: 'block', nearLevel: 'block' };
    expect(modeOf('ROLLOVER', modes)).toBe('block');
    expect(modeOf('NEAR_LEVEL', modes)).toBe('block');
    expect(modeOf('NEWS_WINDOW', modes)).toBe('warn');
    expect(modeOf('OFF_HOURS', modes)).toBe('warn');
  });

  it('five flags have no switch: they warn even when every switch says block', () => {
    const all: AdvisoryModes = {
      newsWindow: 'block',
      rollover: 'block',
      offHours: 'block',
      nearLevel: 'block',
    };
    for (const flag of [
      'NEWS_SHOCK',
      'HEADLINE_RECENT',
      'OPPOSES_OPEN',
      'UNVALIDATED_STRATEGY',
      'NEWS_UNKNOWN',
    ] as const) {
      expect(modeOf(flag, all), flag).toBe('warn');
    }
  });

  it('the settings of the owner override the defaults of the config, one switch at a time', () => {
    expect(resolveModes(DEFAULT_MODES)).toEqual(DEFAULT_MODES);
    expect(resolveModes(DEFAULT_MODES, { offHours: 'block' })).toEqual({
      ...DEFAULT_MODES,
      offHours: 'block',
    });
    const configured: AdvisoryModes = { ...DEFAULT_MODES, newsWindow: 'block', rollover: 'block' };
    expect(resolveModes(configured, { newsWindow: 'warn' })).toEqual({
      ...configured,
      newsWindow: 'warn',
    });
    expect(resolveModes(configured, {})).toEqual(configured);
    expect(resolveModes(DEFAULT_MODES, { rollover: 'block', nearLevel: 'block' })).toEqual({
      newsWindow: 'warn',
      rollover: 'block',
      offHours: 'warn',
      nearLevel: 'block',
    });
  });
});

describe('the decision', () => {
  const gates = evaluateGates(MARKET_OK, SETUP_OK);
  const everyFlag: FlagResult[] = ADVISORY_FLAGS.map((flag) => ({
    flag,
    present: true,
    detail: {},
  }));

  it('a signal is allowed when every gate passes and nothing is switched to block', () => {
    expect(decide(gates, [], DEFAULT_MODES)).toEqual({
      allowed: true,
      failedGates: [],
      blockedBy: [],
      warnings: [],
      rejectionCodes: [],
    });
  });

  it('flags never block unless switched: with every flag present and every mode warn the signal is allowed', () => {
    const decision = decide(gates, everyFlag, DEFAULT_MODES);
    expect(decision.allowed).toBe(true);
    expect(decision.blockedBy).toEqual([]);
    expect(decision.warnings).toEqual([...ADVISORY_FLAGS]);
  });

  it('a present flag that the owner switched to block stops the signal and is recorded as the reason', () => {
    const flags = evaluateFlags(QUIET, {
      ...SETUP,
      nearLevel: { id: 'x', kind: 'ROUND', price: 1, distanceAtr: 0 },
    });
    const decision = decide(gates, flags, { ...DEFAULT_MODES, nearLevel: 'block' });
    expect(decision).toEqual({
      allowed: false,
      failedGates: [],
      blockedBy: ['NEAR_LEVEL'],
      warnings: [],
      rejectionCodes: ['NEAR_LEVEL'],
    });
  });

  it('a switch set to block does nothing while its flag is not present', () => {
    const blockAll: AdvisoryModes = {
      newsWindow: 'block',
      rollover: 'block',
      offHours: 'block',
      nearLevel: 'block',
    };
    expect(decide(gates, evaluateFlags(QUIET, SETUP), blockAll).allowed).toBe(true);
  });

  it('only the flags whose switch is block stop it: the others stay warnings', () => {
    const present = everyFlag.filter((r) =>
      ['ROLLOVER', 'OFF_HOURS', 'NEWS_SHOCK'].includes(r.flag),
    );
    const decision = decide(gates, present, { ...DEFAULT_MODES, offHours: 'block' });
    expect(decision.blockedBy).toEqual(['OFF_HOURS']);
    expect(decision.warnings).toEqual(['NEWS_SHOCK', 'ROLLOVER']);
    expect(decision.allowed).toBe(false);
  });

  it('a failed gate stops it whatever the flags say, and comes first in the rejection codes', () => {
    const failing = evaluateGates({ ...MARKET_OK, spread: 0.9 }, { ...SETUP_OK, qualityScore: 10 });
    const flags = everyFlag.filter((r) => r.flag === 'ROLLOVER');
    const decision = decide(failing, flags, { ...DEFAULT_MODES, rollover: 'block' });
    expect(decision).toEqual({
      allowed: false,
      failedGates: ['SPREAD_OK', 'QUALITY_OK'],
      blockedBy: ['ROLLOVER'],
      warnings: [],
      rejectionCodes: ['SPREAD_OK', 'QUALITY_OK', 'ROLLOVER'],
    });
    expect(decide(failing, [], DEFAULT_MODES).allowed).toBe(false);
  });

  it('lists the warnings in the order of the flags', () => {
    const shuffled = [...everyFlag].reverse();
    expect(decide(gates, shuffled, DEFAULT_MODES).warnings).toEqual([...ADVISORY_FLAGS].reverse());
  });

  it('needs all nine gates: a decision on the market gates alone is refused', () => {
    expect(() => decide(evaluateGates(MARKET_OK, null), [], DEFAULT_MODES)).toThrow(
      'all nine blocking gates',
    );
  });
});

describe('the defaults', () => {
  it('are the windows of docs/02 section 6', () => {
    expect(FLAG_DEFAULTS).toEqual({ headlineMinutes: 30, offHoursMinutes: 30 });
  });
});
