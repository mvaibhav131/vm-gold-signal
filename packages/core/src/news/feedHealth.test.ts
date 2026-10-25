import { describe, expect, it } from 'vitest';

import {
  HEADLINE_FEED_SILENT_MS,
  headlineFeedHealth,
  headlineIncident,
  newsFeedState,
  type HeadlineSource,
} from './feedHealth';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MIN = 60_000;

const source = (key: string, change: Partial<HeadlineSource> = {}): HeadlineSource => ({
  key,
  name: key.toUpperCase(),
  enabled: true,
  lastOkAt: NOW - MIN,
  lastError: null,
  ...change,
});

describe('headlineFeedHealth', () => {
  it('is OK when every feed that is on answered in the last 10 minutes without an error', () => {
    expect(HEADLINE_FEED_SILENT_MS).toBe(10 * MIN);
    const health = headlineFeedHealth(
      [source('a'), source('b', { lastOkAt: NOW - 10 * MIN })],
      NOW,
    );
    expect(health).toEqual({ status: 'OK', enabled: 2, problems: [] });
  });

  it('has a feed silent for more than 10 minutes as a problem, the edge not included', () => {
    const health = headlineFeedHealth(
      [source('a'), source('b', { lastOkAt: NOW - 10 * MIN - 1 })],
      NOW,
    );
    expect(health.status).toBe('PARTIAL');
    expect(health.problems).toEqual([{ key: 'b', name: 'B', reason: 'SILENT', detail: null }]);
  });

  it('has a feed with an error, or one that never answered, as a problem, the error first', () => {
    const health = headlineFeedHealth(
      [
        source('a', { lastError: 'the feed answered 503' }),
        source('b', { lastOkAt: null }),
        source('c', { lastOkAt: null, lastError: 'timeout' }),
        source('d'),
      ],
      NOW,
    );
    expect(health.status).toBe('PARTIAL');
    expect(health.problems).toEqual([
      { key: 'a', name: 'A', reason: 'ERROR', detail: 'the feed answered 503' },
      { key: 'b', name: 'B', reason: 'NEVER', detail: null },
      { key: 'c', name: 'C', reason: 'ERROR', detail: 'timeout' },
    ]);
  });

  it('is DOWN when every feed that is on has a problem, and does not count a feed that is off', () => {
    const health = headlineFeedHealth(
      [
        source('a', { lastError: 'x' }),
        source('b', { lastOkAt: null }),
        source('off', { enabled: false }),
      ],
      NOW,
    );
    expect(health.status).toBe('DOWN');
    expect(health.enabled).toBe(2);
    expect(health.problems.map((problem) => problem.key)).toEqual(['a', 'b']);
  });

  it('says so when none is switched on, and when there is no feed at all', () => {
    expect(headlineFeedHealth([source('a', { enabled: false })], NOW).status).toBe('NONE_ENABLED');
    expect(headlineFeedHealth([], NOW)).toEqual({
      status: 'NONE_ENABLED',
      enabled: 0,
      problems: [],
    });
  });
});

describe('newsFeedState', () => {
  it('is unavailable only when the feeds are down or none is on, so "no headline" is never claimed then', () => {
    const state = (sources: HeadlineSource[]) => newsFeedState(headlineFeedHealth(sources, NOW));
    expect(state([source('a')])).toBe('AVAILABLE');
    expect(state([source('a'), source('b', { lastError: 'x' })])).toBe('AVAILABLE');
    expect(state([source('a', { lastError: 'x' }), source('b', { lastOkAt: null })])).toBe(
      'UNAVAILABLE',
    );
    expect(state([source('a', { enabled: false })])).toBe('UNAVAILABLE');
  });
});

describe('headlineIncident', () => {
  it('is null while any feed that is on answered in the last 10 minutes', () => {
    expect(
      headlineIncident([source('a'), source('b', { lastOkAt: NOW - 30 * MIN })], NOW),
    ).toBeNull();
    expect(
      headlineIncident(
        [source('a', { lastOkAt: NOW - 10 * MIN }), source('b', { lastOkAt: NOW - 30 * MIN })],
        NOW,
      ),
    ).toBeNull();
  });

  it('starts when the last of the feeds went silent, and is the same moment after a restart', () => {
    const sources = [
      source('a', { lastOkAt: NOW - 25 * MIN }),
      source('b', { lastOkAt: NOW - 12 * MIN }),
      source('c', { lastOkAt: NOW - 40 * MIN }),
    ];
    expect(headlineIncident(sources, NOW)).toEqual({
      startedAt: NOW - 12 * MIN,
      silentMs: 12 * MIN,
    });
    expect(headlineIncident(sources, NOW + 5 * MIN)).toEqual({
      startedAt: NOW - 12 * MIN,
      silentMs: 17 * MIN,
    });
  });

  it('starts after the 10 minutes, the edge not included', () => {
    expect(headlineIncident([source('a', { lastOkAt: NOW - 10 * MIN - 1 })], NOW)).not.toBeNull();
    expect(headlineIncident([source('a', { lastOkAt: NOW - 10 * MIN })], NOW)).toBeNull();
  });

  it('does not look at the error of a try, only at how long the feeds were silent', () => {
    expect(headlineIncident([source('a', { lastError: 'x' })], NOW)).toBeNull();
  });

  it('counts a feed that never answered as silent, but needs one that did to say when it began', () => {
    expect(
      headlineIncident(
        [source('a', { lastOkAt: NOW - 20 * MIN }), source('b', { lastOkAt: null })],
        NOW,
      ),
    ).toEqual({ startedAt: NOW - 20 * MIN, silentMs: 20 * MIN });
    expect(headlineIncident([source('a', { lastOkAt: null })], NOW)).toBeNull();
  });

  it('leaves out the feeds that are off, and is null without a feed that is on', () => {
    expect(
      headlineIncident(
        [source('a', { lastOkAt: NOW - 20 * MIN }), source('off', { enabled: false })],
        NOW,
      ),
    ).toEqual({ startedAt: NOW - 20 * MIN, silentMs: 20 * MIN });
    expect(
      headlineIncident([source('off', { enabled: false, lastOkAt: NOW - 90 * MIN })], NOW),
    ).toBeNull();
    expect(headlineIncident([], NOW)).toBeNull();
  });
});
