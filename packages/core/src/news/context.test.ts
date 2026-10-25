import { describe, expect, it } from 'vitest';

import {
  CAUSE_MAX_CLASSIFIED,
  CAUSE_MAX_UNCLASSIFIED,
  CAUSE_WINDOW_MS,
  CONTEXT_MAX_HEADLINES,
  CONTEXT_WINDOW_MS,
  buildClusters,
  contextHeadlines,
  frozenHeadline,
  frozenUnclassified,
  lastHighHeadlineAt,
  possibleCauses,
  timeOf,
  type ClusterItem,
  type HeadlineCluster,
  type UnclassifiedHeadline,
} from './context';

const NOW = Date.UTC(2026, 9, 23, 16, 17, 0);
const MIN = 60_000;

const cluster = (
  id: string,
  minutesAgo: number,
  change: Partial<HeadlineCluster> = {},
): HeadlineCluster => ({
  id,
  title: `Story ${id}`,
  url: `https://example.com/${id}`,
  sources: [{ key: 'bbc', name: 'BBC News' }],
  topics: ['GEOPOLITICS_WAR'],
  impact: 'MEDIUM',
  publishedAt: NOW - minutesAgo * MIN,
  firstSeenAt: NOW - (minutesAgo - 1) * MIN,
  ...change,
});

describe('buildClusters', () => {
  const item = (id: string, change: Partial<ClusterItem> = {}): ClusterItem => ({
    id,
    clusterId: 'c1',
    sourceKey: 'bbc',
    sourceName: 'BBC News',
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: NOW - 10 * MIN,
    firstSeenAt: NOW - 9 * MIN,
    topics: ['GEOPOLITICS_WAR'],
    impact: 'MEDIUM',
    score: 0.5,
    ...change,
  });

  it('is one story for the items of one cluster, with the title and the link of the strongest item', () => {
    const [story] = buildClusters([
      item('a', { score: 0.5 }),
      item('b', { score: 0.8, sourceKey: 'cnbc', sourceName: 'CNBC', impact: 'HIGH' }),
    ]);
    expect(story).toMatchObject({
      id: 'c1',
      title: 'Title b',
      url: 'https://example.com/b',
      impact: 'HIGH',
    });
    expect(story?.sources).toEqual([
      { key: 'bbc', name: 'BBC News' },
      { key: 'cnbc', name: 'CNBC' },
    ]);
  });

  it('takes the earliest seen of two equally strong items, then the smaller id', () => {
    const early = item('z', { firstSeenAt: NOW - 20 * MIN, score: 0.7 });
    const late = item('a', { firstSeenAt: NOW - 10 * MIN, score: 0.7 });
    expect(buildClusters([late, early])[0]?.title).toBe('Title z');
    const same = [item('b', { score: 0.7 }), item('a', { score: 0.7 })];
    expect(buildClusters(same)[0]?.title).toBe('Title a');
  });

  it('lists the outlets in the order they were seen, each once, and the topics of the strongest item first', () => {
    const [story] = buildClusters([
      item('a', {
        sourceKey: 'cnbc',
        sourceName: 'CNBC',
        firstSeenAt: NOW - 8 * MIN,
        topics: ['FED_RATES'],
      }),
      item('b', {
        firstSeenAt: NOW - 9 * MIN,
        topics: ['GEOPOLITICS_WAR', 'TRUMP_POLICY'],
        score: 0.9,
      }),
      item('c', {
        sourceKey: 'cnbc',
        sourceName: 'CNBC',
        firstSeenAt: NOW - 7 * MIN,
        topics: ['TRUMP_POLICY', 'RISK_OFF'],
      }),
    ]);
    expect(story?.sources.map((source) => source.key)).toEqual(['bbc', 'cnbc']);
    expect(story?.topics).toEqual(['GEOPOLITICS_WAR', 'TRUMP_POLICY', 'FED_RATES', 'RISK_OFF']);
  });

  it('has the earliest published time and the earliest seen time, and no time when no item has one', () => {
    const [story] = buildClusters([
      item('a', { publishedAt: NOW - 5 * MIN, firstSeenAt: NOW - 4 * MIN }),
      item('b', { publishedAt: NOW - 8 * MIN, firstSeenAt: NOW - 3 * MIN }),
      item('c', { publishedAt: null, firstSeenAt: NOW - 6 * MIN }),
    ]);
    expect(story).toMatchObject({ publishedAt: NOW - 8 * MIN, firstSeenAt: NOW - 6 * MIN });
    expect(buildClusters([item('d', { publishedAt: null })])[0]?.publishedAt).toBeNull();
  });

  it('has the highest impact of its items, and several clusters come in the order they were first seen', () => {
    const stories = buildClusters([
      item('a', { clusterId: 'late', firstSeenAt: NOW - 2 * MIN, impact: 'LOW' }),
      item('b', { clusterId: 'early', firstSeenAt: NOW - 9 * MIN, impact: 'LOW' }),
      item('c', { clusterId: 'early', firstSeenAt: NOW - 8 * MIN, impact: 'HIGH', score: 0.1 }),
      item('d', { clusterId: 'early', firstSeenAt: NOW - 7 * MIN, impact: 'MEDIUM' }),
    ]);
    expect(stories.map((story) => [story.id, story.impact])).toEqual([
      ['early', 'HIGH'],
      ['late', 'LOW'],
    ]);
    expect(buildClusters([])).toEqual([]);
  });
});

describe('timeOf', () => {
  it('is the published time, or the time it was first seen when the feed gave none', () => {
    expect(timeOf({ publishedAt: 5, firstSeenAt: 9 })).toBe(5);
    expect(timeOf({ publishedAt: null, firstSeenAt: 9 })).toBe(9);
  });
});

describe('frozenHeadline and frozenUnclassified', () => {
  it('keeps what the contract of a frozen headline asks for: title, outlets, time, impact, topics, link', () => {
    const frozen = frozenHeadline(
      cluster('a', 3, {
        sources: [
          { key: 'bbc', name: 'BBC News' },
          { key: 'cnbc', name: 'CNBC' },
        ],
        impact: 'HIGH',
        topics: ['TRUMP_POLICY', 'GOLD_DIRECT'],
      }),
    );
    expect(frozen).toEqual({
      title: 'Story a',
      sources: ['BBC News', 'CNBC'],
      publishedAt: new Date(NOW - 3 * MIN).toISOString(),
      impact: 'HIGH',
      topics: ['TRUMP_POLICY', 'GOLD_DIRECT'],
      url: 'https://example.com/a',
      classified: true,
    });
  });

  it('keeps a headline that no rule recognised as timing only, with no impact and no topics', () => {
    const item: UnclassifiedHeadline = {
      title: 'Local bakery wins a prize',
      url: 'https://example.com/b',
      sourceName: 'Al Jazeera',
      publishedAt: null,
      firstSeenAt: NOW,
    };
    const frozen = frozenUnclassified(item);
    expect(frozen).toEqual({
      title: 'Local bakery wins a prize',
      sources: ['Al Jazeera'],
      publishedAt: null,
      impact: null,
      topics: [],
      url: 'https://example.com/b',
      classified: false,
    });
  });
});

describe('contextHeadlines (News, last 60 min)', () => {
  it('is the stories of the last hour, HIGH first and the newest first within an impact, at most three', () => {
    expect(CONTEXT_WINDOW_MS).toBe(60 * MIN);
    expect(CONTEXT_MAX_HEADLINES).toBe(3);
    const clusters = [
      cluster('low-new', 2, { impact: 'LOW' }),
      cluster('med-old', 40, { impact: 'MEDIUM' }),
      cluster('high-old', 50, { impact: 'HIGH' }),
      cluster('med-new', 5, { impact: 'MEDIUM' }),
      cluster('high-new', 20, { impact: 'HIGH' }),
    ];
    expect(contextHeadlines(clusters, NOW).map((h) => h.title)).toEqual([
      'Story high-new',
      'Story high-old',
      'Story med-new',
    ]);
  });

  it('leaves out a story older than an hour, the edge included, and one from the future', () => {
    const clusters = [cluster('edge', 60), cluster('old', 60.01), cluster('future', -1)];
    expect(contextHeadlines(clusters, NOW).map((h) => h.title)).toEqual(['Story edge']);
  });

  it('dates a story without a published time by when it was first seen', () => {
    const noTime = cluster('seen', 0, { publishedAt: null, firstSeenAt: NOW - 59 * MIN });
    expect(contextHeadlines([noTime], NOW)).toHaveLength(1);
    expect(contextHeadlines([{ ...noTime, firstSeenAt: NOW - 61 * MIN }], NOW)).toEqual([]);
  });

  it('is empty without a story, and the id decides between stories of the same time and impact', () => {
    expect(contextHeadlines([], NOW)).toEqual([]);
    const same = [cluster('b', 5), cluster('a', 5)];
    expect(contextHeadlines(same, NOW).map((h) => h.title)).toEqual(['Story a', 'Story b']);
  });
});

describe('lastHighHeadlineAt', () => {
  it('is when the newest HIGH story was published, and null without one', () => {
    const clusters = [
      cluster('h1', 50, { impact: 'HIGH' }),
      cluster('m', 1, { impact: 'MEDIUM' }),
      cluster('h2', 20, { impact: 'HIGH' }),
    ];
    expect(lastHighHeadlineAt(clusters, NOW)).toBe(NOW - 20 * MIN);
    expect(
      lastHighHeadlineAt(
        clusters.filter((c) => c.impact !== 'HIGH'),
        NOW,
      ),
    ).toBeNull();
    expect(lastHighHeadlineAt([], NOW)).toBeNull();
  });

  it('does not count a story from the future, and dates one without a time by when it was seen', () => {
    expect(lastHighHeadlineAt([cluster('f', -5, { impact: 'HIGH' })], NOW)).toBeNull();
    const seen = cluster('s', 0, { impact: 'HIGH', publishedAt: null, firstSeenAt: NOW - 7 * MIN });
    expect(lastHighHeadlineAt([seen], NOW)).toBe(NOW - 7 * MIN);
  });
});

describe('possibleCauses', () => {
  const unclassified = (title: string, minutesAgo: number): UnclassifiedHeadline => ({
    title,
    url: `https://example.com/${title}`,
    sourceName: 'Al Jazeera',
    publishedAt: NOW - minutesAgo * MIN,
    firstSeenAt: NOW - minutesAgo * MIN,
  });

  it('lists the stories of the 30 minutes before the move by impact, then those no rule recognised', () => {
    expect(CAUSE_WINDOW_MS).toBe(30 * MIN);
    const causes = possibleCauses(
      [
        cluster('med', 9, { impact: 'MEDIUM' }),
        cluster('high', 16, { impact: 'HIGH' }),
        cluster('old', 31, { impact: 'HIGH' }),
      ],
      [unclassified('x', 3)],
      NOW,
    );
    expect(
      causes.map((cause) => [cause.headline.title, cause.headline.classified, cause.at]),
    ).toEqual([
      ['Story high', true, NOW - 16 * MIN],
      ['Story med', true, NOW - 9 * MIN],
      ['x', false, NOW - 3 * MIN],
    ]);
  });

  it('takes at most five classified stories and three unclassified ones, the closest in time first', () => {
    expect(CAUSE_MAX_CLASSIFIED).toBe(5);
    expect(CAUSE_MAX_UNCLASSIFIED).toBe(3);
    const stories = Array.from({ length: 8 }, (_, i) =>
      cluster(`c${String(i)}`, i + 1, { impact: 'LOW' }),
    );
    const others = [
      unclassified('d', 20),
      unclassified('a', 2),
      unclassified('c', 12),
      unclassified('b', 7),
    ];
    const causes = possibleCauses(stories, others, NOW);
    expect(causes.filter((cause) => cause.headline.classified)).toHaveLength(5);
    expect(causes.slice(5).map((cause) => cause.headline.title)).toEqual(['a', 'b', 'c']);
  });

  it('counts the edge of the window, and nothing after the move', () => {
    const edge = cluster('edge', 30, { impact: 'LOW' });
    const after = cluster('after', -1, { impact: 'HIGH' });
    expect(
      possibleCauses([edge, after], [unclassified('late', -1), unclassified('edge', 30)], NOW).map(
        (c) => c.headline.title,
      ),
    ).toEqual(['Story edge', 'edge']);
    expect(possibleCauses([], [], NOW)).toEqual([]);
  });
});
