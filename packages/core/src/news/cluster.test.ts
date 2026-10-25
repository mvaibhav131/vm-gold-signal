import { describe, expect, it } from 'vitest';

import {
  CLUSTER_MIN_SHARED,
  CLUSTER_MIN_SIMILARITY,
  CLUSTER_WINDOW_MS,
  findCluster,
  probeOf,
  sameStory,
  type ClusterEntry,
} from './cluster';

const T = Date.UTC(2026, 9, 23, 16, 12, 0);
const MIN = 60_000;

const entry = (clusterId: string, title: string, at: number): ClusterEntry => {
  const probe = probeOf(title, at);
  return { clusterId, tokens: probe.tokens, normalized: probe.normalized, at };
};

describe('sameStory', () => {
  it('is the same title, however it is written', () => {
    expect(sameStory(probeOf('Fed holds rates!', T), probeOf('FED HOLDS RATES', T))).toBe(true);
    expect(sameStory(probeOf('', T), probeOf('', T))).toBe(false);
  });

  it('is two outlets telling one story in their own words', () => {
    expect(
      sameStory(
        probeOf('Trump announces new tariffs on European goods', T),
        probeOf('US to impose tariffs on European goods, Trump says', T),
      ),
    ).toBe(true);
    expect(
      sameStory(
        probeOf('Missile strike reported near Kharkiv, officials say', T),
        probeOf('Officials say missile strike hit near Kharkiv', T),
      ),
    ).toBe(true);
  });

  it('is not two stories that share a name or a few words', () => {
    expect(
      sameStory(
        probeOf('Trump meets Xi in Beijing', T),
        probeOf('Trump announces new tariffs on European goods', T),
      ),
    ).toBe(false);
    expect(
      sameStory(
        probeOf('Fed holds rates steady', T),
        probeOf('Fed holds fundraiser for charity', T),
      ),
    ).toBe(false);
  });

  it('needs the words to be alike and enough of them in common, both', () => {
    expect(CLUSTER_MIN_SHARED).toBe(3);
    expect(CLUSTER_MIN_SIMILARITY).toBe(0.6);
    // 3 shared of 3 and 6: dice 2*3/9 = 0.67 passes; of 3 and 7: 0.6 passes; of 3 and 8: 0.55 does not
    const base = probeOf('alpha beta gamma', T);
    expect(sameStory(base, probeOf('alpha beta gamma delta epsilon zeta', T))).toBe(true);
    expect(sameStory(base, probeOf('alpha beta gamma delta epsilon zeta eta', T))).toBe(true);
    expect(sameStory(base, probeOf('alpha beta gamma delta epsilon zeta eta theta', T))).toBe(
      false,
    );
    // two words in common are never enough, even if they are all the words
    expect(sameStory(probeOf('alpha beta', T), probeOf('alpha beta gamma', T))).toBe(false);
  });
});

describe('findCluster', () => {
  const stored = [
    entry('c-tariff', 'Trump announces new tariffs on European goods', T - 20 * MIN),
    entry('c-fed', 'Fed holds rates steady as inflation cools', T - 10 * MIN),
  ];

  it('joins the story that is already there', () => {
    const probe = probeOf('US to impose tariffs on European goods, Trump says', T);
    expect(findCluster(probe, stored)).toBe('c-tariff');
  });

  it('is a new story when nothing is alike', () => {
    expect(findCluster(probeOf('Oil prices jump after pipeline outage', T), stored)).toBeNull();
    expect(findCluster(probeOf('anything', T), [])).toBeNull();
  });

  it('only looks an hour back and an hour ahead, the edge included', () => {
    expect(CLUSTER_WINDOW_MS).toBe(60 * MIN);
    const title = 'Trump announces new tariffs on European goods';
    const old = [entry('c-old', title, T - 60 * MIN)];
    expect(findCluster(probeOf(title, T), old)).toBe('c-old');
    expect(findCluster(probeOf(title, T + 1), old)).toBeNull();
    const ahead = [entry('c-ahead', title, T + 60 * MIN)];
    expect(findCluster(probeOf(title, T), ahead)).toBe('c-ahead');
    expect(findCluster(probeOf(title, T - 1), ahead)).toBeNull();
  });

  it('takes the most alike, then the older, then the smaller id', () => {
    const probe = probeOf('Trump announces tariffs on European goods', T);
    const exact = entry('c-exact', 'Trump announces tariffs on European goods', T - 5 * MIN);
    const near = entry(
      'c-near',
      'Trump announces new tariffs on European goods today',
      T - 30 * MIN,
    );
    expect(findCluster(probe, [near, exact])).toBe('c-exact');

    const a = entry('c-b', 'Trump announces new tariffs on European goods', T - 5 * MIN);
    const b = entry('c-a', 'Trump announces new tariffs on European goods', T - 5 * MIN);
    const older = entry('c-z', 'Trump announces new tariffs on European goods', T - 6 * MIN);
    expect(findCluster(probe, [a, b])).toBe('c-a');
    expect(findCluster(probe, [a, b, older])).toBe('c-z');
    expect(findCluster(probe, [older, b, a])).toBe('c-z');
  });
});
