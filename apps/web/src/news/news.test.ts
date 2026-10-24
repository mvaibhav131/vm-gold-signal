import type { FrozenHeadline, MacroEvent, NewsStateResponse } from '@vmgs/contracts';
import { describe, expect, it } from 'vitest';

import {
  headlineFeedStatus,
  sourceProblem,
  FEED_STALE_AFTER_MS,
  type NewsSourceHealth,
} from './feeds';
import {
  activeNewsWindow,
  newsWindowOf,
  NEWS_WINDOW_AFTER_MIN,
  NEWS_WINDOW_BEFORE_MIN,
} from './window';
import { atrBasis, rankPossibleCauses, signedMoveUsd, windowLabel } from './moves';
import { newsViewFromParams, withNewsParam } from './NewsPage';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const source = (change: Partial<NewsSourceHealth> = {}): NewsSourceHealth => ({
  key: 'a',
  name: 'Feed A',
  enabled: true,
  lastOkAt: iso(-MIN),
  lastError: null,
  ...change,
});

describe('why a headline feed is not working', () => {
  it('has no problem when it answered a minute ago', () => {
    expect(sourceProblem(source(), NOW)).toBeNull();
  });

  it('says the error that it reported, even if it answered a minute ago', () => {
    expect(sourceProblem(source({ lastError: 'Timed out after 20 s' }), NOW)).toBe(
      'Timed out after 20 s',
    );
  });

  it('says that it never worked', () => {
    expect(sourceProblem(source({ lastOkAt: null }), NOW)).toBe('No successful poll yet');
  });

  it('is working until 10 minutes of silence and not working after them', () => {
    expect(FEED_STALE_AFTER_MS).toBe(10 * MIN);
    expect(sourceProblem(source({ lastOkAt: iso(-10 * MIN) }), NOW)).toBeNull();
    expect(sourceProblem(source({ lastOkAt: iso(-10 * MIN - 1000) }), NOW)).toBe(
      'No successful poll for 10 min',
    );
    expect(sourceProblem(source({ lastOkAt: iso(-26 * 3_600_000) }), NOW)).toBe(
      'No successful poll for 1 d 2 h',
    );
  });

  it('is no problem for a feed that the owner switched off, whatever its state', () => {
    expect(
      sourceProblem(source({ enabled: false, lastError: 'boom', lastOkAt: null }), NOW),
    ).toBeNull();
  });
});

describe('the state of all the headline feeds', () => {
  const bad = (key: string) => source({ key, name: `Feed ${key}`, lastError: 'down' });

  it('is OK when every feed that is switched on works', () => {
    const status = headlineFeedStatus([source({ key: 'a' }), source({ key: 'b' })], NOW);
    expect([status.state, status.enabled, status.problems]).toEqual(['OK', 2, []]);
  });

  it('is DOWN when every feed that is switched on has a problem', () => {
    const status = headlineFeedStatus([bad('a'), bad('b')], NOW);
    expect(status.state).toBe('DOWN');
    expect(status.problems.map((p) => [p.source.key, p.reason])).toEqual([
      ['a', 'down'],
      ['b', 'down'],
    ]);
  });

  it('is PARTIAL when some do and some do not', () => {
    const status = headlineFeedStatus([bad('a'), source({ key: 'b' }), source({ key: 'c' })], NOW);
    expect([status.state, status.enabled, status.problems.length]).toEqual(['PARTIAL', 3, 1]);
  });

  it('is DOWN for a single feed with a problem, and counts only the feeds that are switched on', () => {
    expect(headlineFeedStatus([bad('a')], NOW).state).toBe('DOWN');
    // the owner switched feed b off: it is not counted, and not a problem
    const status = headlineFeedStatus(
      [bad('a'), source({ key: 'b', enabled: false, lastError: 'x' })],
      NOW,
    );
    expect([status.state, status.enabled]).toEqual(['DOWN', 1]);
  });

  it('is NONE when no feed is switched on, and when there is none at all', () => {
    expect(headlineFeedStatus([source({ enabled: false })], NOW).state).toBe('NONE');
    expect(headlineFeedStatus([], NOW)).toEqual({ state: 'NONE', enabled: 0, problems: [] });
  });
});

describe('the news window', () => {
  const event: MacroEvent = {
    id: '00000000-0000-4000-8000-00000000e001',
    name: 'US CPI',
    scheduledAt: iso(30 * MIN),
    importance: 'high',
    currency: 'USD',
    unit: '%',
    actual: null,
    forecast: 0.3,
    previous: 0.4,
    revisedPrevious: null,
  };
  const state = (
    next: MacroEvent | null,
    last: MacroEvent | null = null,
    s: NewsStateResponse['state'] = 'IN_WINDOW',
  ): NewsStateResponse => ({
    state: s,
    next,
    last,
    sourceAgeS: 45,
  });

  it('runs from 45 minutes before the event to 20 minutes after it', () => {
    expect([NEWS_WINDOW_BEFORE_MIN, NEWS_WINDOW_AFTER_MIN]).toEqual([45, 20]);
    const window = newsWindowOf(event);
    expect(window.fromMs).toBe(NOW + 30 * MIN - 45 * MIN);
    expect(window.toMs).toBe(NOW + 30 * MIN + 20 * MIN);
    expect(window.event).toBe(event);
  });

  it('is the window of the next event once it has begun, up to and including its end', () => {
    const at = (offset: number) => activeNewsWindow(state(event), NOW + offset);
    expect(at(-16 * MIN)).toBeNull(); // 46 minutes before the event
    expect(at(-15 * MIN)?.event).toBe(event); // exactly 45 minutes before
    expect(at(0)?.event).toBe(event);
    expect(at(50 * MIN)?.event).toBe(event); // exactly 20 minutes after
    expect(at(50 * MIN + 1)).toBeNull();
  });

  it('is the window of the event that was just released when the next one is far away', () => {
    const released: MacroEvent = { ...event, scheduledAt: iso(-10 * MIN), actual: 0.5 };
    const far: MacroEvent = {
      ...event,
      id: '00000000-0000-4000-8000-00000000e002',
      scheduledAt: iso(5 * 3_600_000),
    };
    expect(activeNewsWindow(state(far, released), NOW)?.event).toBe(released);
    // the window ends 20 minutes after the release, which was 10 minutes ago
    expect(activeNewsWindow(state(far, released), NOW + 10 * MIN)?.event).toBe(released);
    expect(activeNewsWindow(state(far, released), NOW + 10 * MIN + 1)).toBeNull();
  });

  it('is nothing when there is no event at all', () => {
    expect(activeNewsWindow(state(null, null, 'UNKNOWN'), NOW)).toBeNull();
  });

  it('is the window of the next event when the windows of the next and of the last overlap', () => {
    // the last event was 10 minutes ago (its window lasts 10 more minutes) and the next is in
    // 30 minutes (its window began 15 minutes ago): both contain now, and the page names the next one
    const released: MacroEvent = { ...event, scheduledAt: iso(-10 * MIN), actual: 0.5 };
    const next: MacroEvent = { ...event, id: '00000000-0000-4000-8000-00000000e002' };
    expect(activeNewsWindow(state(next, released), NOW)?.event).toBe(next);
  });
});

describe('the possible causes of a move', () => {
  const headline = (
    title: string,
    impact: 'LOW' | 'MEDIUM' | 'HIGH' | null,
    minutesBefore: number | null,
  ): FrozenHeadline => ({
    title,
    sources: ['A'],
    publishedAt: minutesBefore === null ? null : iso(-minutesBefore * MIN),
    impact,
    topics: impact === null ? [] : ['FED_RATES'],
    url: `https://example.com/${title}`,
    classified: impact !== null,
  });

  it('ranks the classified ones by impact, then the newest, and puts the timing-only ones last', () => {
    const ranked = rankPossibleCauses([
      headline('timing-old', null, 20),
      headline('medium-new', 'MEDIUM', 2),
      headline('high-old', 'HIGH', 25),
      headline('timing-new', null, 1),
      headline('high-new', 'HIGH', 5),
      headline('low', 'LOW', 3),
    ]);
    expect(ranked.map((h) => h.title)).toEqual([
      'high-new',
      'high-old',
      'medium-new',
      'low',
      'timing-new',
      'timing-old',
    ]);
  });

  it('puts a headline with no publish time after the others of its kind, and does not change what it was given', () => {
    const input = [headline('no-time', 'HIGH', null), headline('time', 'HIGH', 10)];
    expect(rankPossibleCauses(input).map((h) => h.title)).toEqual(['time', 'no-time']);
    expect(input.map((h) => h.title)).toEqual(['no-time', 'time']);
    expect(rankPossibleCauses([])).toEqual([]);
  });

  it('orders the timing-only ones by time alone, even if one of them carries an impact', () => {
    const odd: FrozenHeadline = { ...headline('timing-old-high', 'HIGH', 20), classified: false };
    const ranked = rankPossibleCauses([odd, headline('timing-new', null, 1)]);
    expect(ranked.map((h) => h.title)).toEqual(['timing-new', 'timing-old-high']);
  });
});

describe('how a move is described', () => {
  it('names the window in minutes, or in seconds when it is not whole minutes', () => {
    expect([windowLabel(300), windowLabel(60), windowLabel(45), windowLabel(90)]).toEqual([
      '5 min',
      '1 min',
      '45 s',
      '90 s',
    ]);
  });

  it('measures a 1-minute window against the 1-minute ATR and a longer one against the 5-minute ATR', () => {
    expect([atrBasis(60), atrBasis(30), atrBasis(61), atrBasis(300)]).toEqual([
      '1m',
      '1m',
      '5m',
      '5m',
    ]);
  });

  it('gives the size of a move the sign of its direction', () => {
    expect(signedMoveUsd('SPIKE_UP', 9.8)).toBe('+9.80 USD');
    expect(signedMoveUsd('SPIKE_DOWN', 7.2)).toBe('-7.20 USD');
    expect(signedMoveUsd('SPIKE_DOWN', -7.2)).toBe('-7.20 USD');
    expect(signedMoveUsd('SPIKE_UP', 4.105)).toBe('+4.11 USD');
  });
});

describe('the news view in the address', () => {
  it('opens the calendar when nothing is asked for', () => {
    expect(newsViewFromParams(new URLSearchParams(''))).toEqual({
      tab: 'calendar',
      importance: undefined,
      minImpact: undefined,
      topic: undefined,
    });
  });

  it('reads the tab and the filters, and ignores a value that is not valid', () => {
    const view = newsViewFromParams(
      new URLSearchParams('tab=headlines&impact=HIGH&topic=FED_RATES&importance=medium'),
    );
    expect(view).toEqual({
      tab: 'headlines',
      importance: 'medium',
      minImpact: 'HIGH',
      topic: 'FED_RATES',
    });
    expect(
      newsViewFromParams(
        new URLSearchParams('tab=weather&impact=URGENT&topic=SPORT&importance=HIGH'),
      ),
    ).toEqual({ tab: 'calendar', importance: undefined, minImpact: undefined, topic: undefined });
    // the values are case sensitive, as in the contract
    expect(newsViewFromParams(new URLSearchParams('impact=high')).minImpact).toBeUndefined();
  });

  it('sets and removes one parameter and keeps the others, without changing the ones it was given', () => {
    const base = new URLSearchParams('tab=headlines&impact=HIGH');
    expect(withNewsParam(base, 'topic', 'RISK_OFF').toString()).toBe(
      'tab=headlines&impact=HIGH&topic=RISK_OFF',
    );
    expect(withNewsParam(base, 'impact', undefined).toString()).toBe('tab=headlines');
    expect(withNewsParam(base, 'impact', '').toString()).toBe('tab=headlines');
    expect(withNewsParam(base, 'impact', 'LOW').toString()).toBe('tab=headlines&impact=LOW');
    expect(base.toString()).toBe('tab=headlines&impact=HIGH');
  });
});
