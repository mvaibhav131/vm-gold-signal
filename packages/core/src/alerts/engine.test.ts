import { describe, expect, it } from 'vitest';

import { engineFactsOf, isPaused, pauseIdOf, pausedAt, type StoredEngine } from './engine';

const NOW = 1_800_000_000_000;

describe('pausedAt', () => {
  it('has no end without minutes', () => {
    expect(pausedAt(NOW, null)).toEqual({ status: 'PAUSED', since: NOW, until: null });
  });

  it('ends after the minutes given', () => {
    expect(pausedAt(NOW, 30)).toEqual({ status: 'PAUSED', since: NOW, until: NOW + 1_800_000 });
  });
});

describe('isPaused', () => {
  const timed: StoredEngine = { status: 'PAUSED', since: NOW, until: NOW + 60_000 };

  it('is false while running', () => {
    expect(isPaused({ status: 'RUNNING' }, NOW)).toBe(false);
  });

  it('is true until /resume when there is no end', () => {
    expect(isPaused({ status: 'PAUSED', since: NOW, until: null }, NOW + 10 ** 12)).toBe(true);
  });

  it('is true before the end and false from the end on', () => {
    expect(isPaused(timed, NOW + 59_999)).toBe(true);
    expect(isPaused(timed, NOW + 60_000)).toBe(false);
  });
});

describe('engineFactsOf', () => {
  it('reports a running engine', () => {
    expect(engineFactsOf({ status: 'RUNNING' }, NOW)).toEqual({ status: 'RUNNING' });
  });

  it('reports the pause with its start and end', () => {
    expect(engineFactsOf({ status: 'PAUSED', since: NOW, until: NOW + 5000 }, NOW + 1)).toEqual({
      status: 'PAUSED',
      since: NOW,
      until: NOW + 5000,
    });
  });

  it('reports a pause that has run out as running', () => {
    expect(engineFactsOf({ status: 'PAUSED', since: NOW, until: NOW + 5000 }, NOW + 5000)).toEqual({
      status: 'RUNNING',
    });
  });
});

describe('pauseIdOf', () => {
  it('names the pause by the time it began', () => {
    expect(pauseIdOf(NOW)).toBe('1800000000000');
  });
});
