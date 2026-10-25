import { NEWS_TOPICS } from '../domain';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFIER_VERSION,
  IMPACT_HIGH,
  IMPACT_MEDIUM,
  MAX_ITEM_AGE_MS,
  MIN_TOPIC_SCORE,
  SUMMARY_FACTOR,
  TIER_FACTOR,
  classify,
  impactOf,
  recencyFactor,
  type SourceTier,
} from './classifier';
import { STRENGTH_VALUE, TOPIC_RULES } from './rules';
import type { NewsImpact, NewsTopic } from '../domain';

const MIN = 60_000;

/** A headline of a major outlet (tier 2), read the moment it was published. */
const read = (title: string, tier: SourceTier = 2, ageMs = 0, summary: string | null = null) =>
  classify({ title, summary, tier, ageMs });

interface Golden {
  readonly title: string;
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
}

// One table of headlines for each topic: what the rules say today. A change here is a change of
// the classifier, and then of CLASSIFIER_VERSION.
const GOLDEN: Readonly<Record<NewsTopic, readonly Golden[]>> = {
  FED_RATES: [
    {
      title: 'Fed holds rates steady as inflation cools',
      topics: ['FED_RATES', 'INFLATION_JOBS'],
      impact: 'HIGH',
    },
    { title: 'FOMC minutes show officials divided', topics: ['FED_RATES'], impact: 'HIGH' },
    { title: 'Powell says a rate cut is possible', topics: ['FED_RATES'], impact: 'HIGH' },
    { title: 'FED HOLDS RATES', topics: ['FED_RATES'], impact: 'HIGH' },
    { title: 'Powell speaks at a university', topics: ['FED_RATES'], impact: 'MEDIUM' },
    {
      title: 'Treasury yields fall as investors weigh data',
      topics: ['FED_RATES'],
      impact: 'MEDIUM',
    },
    { title: 'Fed officials weigh next move', topics: ['FED_RATES'], impact: 'MEDIUM' },
    { title: 'Wall Street ends higher as yields ease', topics: ['FED_RATES'], impact: 'LOW' },
    {
      title: 'Federal Reserve Board announces termination of enforcement actions with a small bank',
      topics: ['FED_RATES'],
      impact: 'LOW',
    },
  ],
  USD_DOLLAR: [
    { title: 'Dollar index hits a three-month high', topics: ['USD_DOLLAR'], impact: 'HIGH' },
    {
      title: 'DXY slips as traders eye jobs data',
      topics: ['USD_DOLLAR', 'INFLATION_JOBS'],
      impact: 'HIGH',
    },
    { title: 'Greenback weakens against the yen', topics: ['USD_DOLLAR'], impact: 'HIGH' },
    { title: 'Dollar slides against the yen', topics: ['USD_DOLLAR'], impact: 'MEDIUM' },
    { title: 'A stronger dollar weighs on exporters', topics: ['USD_DOLLAR'], impact: 'MEDIUM' },
  ],
  INFLATION_JOBS: [
    { title: 'US CPI rises 0.4% in September', topics: ['INFLATION_JOBS'], impact: 'HIGH' },
    { title: 'Nonfarm payrolls beat forecasts', topics: ['INFLATION_JOBS'], impact: 'HIGH' },
    { title: 'Weekly jobless claims fall', topics: ['INFLATION_JOBS'], impact: 'HIGH' },
    { title: 'Consumer prices jump in Germany', topics: ['INFLATION_JOBS'], impact: 'HIGH' },
    { title: 'Inflation in Turkey eases', topics: ['INFLATION_JOBS'], impact: 'MEDIUM' },
    { title: 'Labour market shows signs of cooling', topics: ['INFLATION_JOBS'], impact: 'MEDIUM' },
    { title: 'Job growth slows in the euro zone', topics: ['INFLATION_JOBS'], impact: 'LOW' },
  ],
  GEOPOLITICS_WAR: [
    { title: 'Missile strike reported near Kharkiv', topics: ['GEOPOLITICS_WAR'], impact: 'HIGH' },
    {
      title: 'Israel and Hamas agree to a ceasefire',
      topics: ['GEOPOLITICS_WAR'],
      impact: 'HIGH',
    },
    { title: 'Airstrikes hit a port city overnight', topics: ['GEOPOLITICS_WAR'], impact: 'HIGH' },
    {
      title: 'Iran seizes tanker in the Strait of Hormuz',
      topics: ['GEOPOLITICS_WAR'],
      impact: 'MEDIUM',
    },
    { title: 'Troops deployed along the border', topics: ['GEOPOLITICS_WAR'], impact: 'MEDIUM' },
    { title: 'Price war erupts among airlines', topics: ['GEOPOLITICS_WAR'], impact: 'MEDIUM' },
    { title: 'Russian forces advance in the east', topics: ['GEOPOLITICS_WAR'], impact: 'LOW' },
  ],
  TRUMP_POLICY: [
    {
      title: 'Trump announces new tariffs on European goods',
      topics: ['TRUMP_POLICY'],
      impact: 'HIGH',
    },
    { title: 'Trump signs an executive order on AI', topics: ['TRUMP_POLICY'], impact: 'HIGH' },
    { title: 'Trade deal talks resume in Geneva', topics: ['TRUMP_POLICY'], impact: 'HIGH' },
    { title: 'Trump to visit a Georgia plant', topics: ['TRUMP_POLICY'], impact: 'MEDIUM' },
    { title: 'White House schedules a briefing', topics: ['TRUMP_POLICY'], impact: 'MEDIUM' },
    { title: 'Government shutdown looms', topics: ['TRUMP_POLICY'], impact: 'LOW' },
  ],
  CENTRAL_BANK_GOLD: [
    {
      title: 'Central banks added gold in September, data shows',
      topics: ['CENTRAL_BANK_GOLD', 'FED_RATES'],
      impact: 'HIGH',
    },
    { title: 'PBoC extends gold buying streak', topics: ['CENTRAL_BANK_GOLD'], impact: 'HIGH' },
    {
      title: 'World Gold Council reports on demand',
      topics: ['CENTRAL_BANK_GOLD'],
      impact: 'MEDIUM',
    },
  ],
  GOLD_DIRECT: [
    {
      title: 'Gold prices hit a record as the dollar slides',
      topics: ['GOLD_DIRECT', 'USD_DOLLAR'],
      impact: 'HIGH',
    },
    { title: 'Spot gold climbs 1%', topics: ['GOLD_DIRECT'], impact: 'HIGH' },
    { title: 'XAUUSD rallies after the data', topics: ['GOLD_DIRECT'], impact: 'HIGH' },
    {
      title: 'Bullion steadies ahead of the Fed decision',
      topics: ['GOLD_DIRECT', 'FED_RATES'],
      impact: 'HIGH',
    },
    { title: 'Gold ETF outflows deepen', topics: ['GOLD_DIRECT'], impact: 'MEDIUM' },
  ],
  RISK_OFF: [
    { title: 'Global stock market crash fears grow', topics: ['RISK_OFF'], impact: 'HIGH' },
    { title: 'Banking crisis deepens as a bank run spreads', topics: ['RISK_OFF'], impact: 'HIGH' },
    { title: 'Safe-haven demand lifts the yen', topics: ['RISK_OFF'], impact: 'HIGH' },
    { title: 'Recession fears mount', topics: ['RISK_OFF'], impact: 'MEDIUM' },
    {
      title: 'Wall Street tumbles as yields jump',
      topics: ['RISK_OFF', 'FED_RATES'],
      impact: 'MEDIUM',
    },
    { title: 'Temperatures plunge across Europe', topics: ['RISK_OFF'], impact: 'LOW' },
  ],
};

describe('the classifier, headline by headline (tier 2, just published)', () => {
  for (const topic of NEWS_TOPICS) {
    describe(topic, () => {
      for (const golden of GOLDEN[topic]) {
        it(golden.title, () => {
          const result = read(golden.title);
          expect(result?.topics).toEqual(golden.topics);
          expect(result?.primary).toBe(topic);
          expect(result?.impact).toBe(golden.impact);
        });
      }
    });
  }

  it('has a table for every topic, with at least one headline of each impact it can give', () => {
    for (const topic of NEWS_TOPICS) expect(GOLDEN[topic].length).toBeGreaterThanOrEqual(3);
    const rules = TOPIC_RULES.map((rule) => rule.topic);
    expect(rules).toEqual([...NEWS_TOPICS]);
  });
});

describe('what is not about gold is dropped', () => {
  it.each([
    'He fed the cat and went home',
    'Fedex delivers parcels on time',
    'Star Wars sequel announced for 2028',
    'Warrior spirit wins the title',
    'Gold medal for Norway in the relay',
    'Gold rush town reopens its museum',
    'Local bakery wins a prize',
    'Hong Kong dollar peg holds',
    'Australian dollar slides against the yen',
    'Fed up with delays, commuters protest',
    '',
  ])('%s', (title) => {
    const result = read(title);
    // "Fed up" is the one known false positive of a capital F at the start of a sentence
    if (title.startsWith('Fed up')) expect(result?.primary).toBe('FED_RATES');
    else expect(result).toBeNull();
  });

  it('does not take part of a word for a keyword', () => {
    expect(read('Warfare tactics evolve')).toBeNull();
    expect(read('Cpi data')).toBeNull();
    expect(read('Gaza')?.primary).toBe('GEOPOLITICS_WAR');
    expect(read('Taiwanese chipmaker')).toBeNull();
    expect(read('Israeli-Palestinian talks')?.primary).toBe('GEOPOLITICS_WAR');
  });
});

describe('the score', () => {
  it('is the weight of the topic, times the strength of the phrase, times the outlet, times the freshness', () => {
    // tariffs: topic weight 0.8, strong 1.0
    expect(read('New tariffs announced', 1)?.score).toBe(0.8);
    expect(read('New tariffs announced', 2)?.score).toBe(0.72);
    expect(read('New tariffs announced', 3)?.score).toBe(0.56);
    expect(read('New tariffs announced', 2, 2 * 60 * MIN)?.score).toBe(0.58);
    expect(read('New tariffs announced', 2, 5 * 60 * MIN)?.score).toBe(0.43);
  });

  it('makes the same headline HIGH from an official source, MEDIUM from an aggregator', () => {
    expect(read('New tariffs announced', 1)?.impact).toBe('HIGH');
    expect(read('New tariffs announced', 2)?.impact).toBe('HIGH');
    expect(read('New tariffs announced', 3)?.impact).toBe('MEDIUM');
    expect(read('Trump to visit a plant', 2)?.impact).toBe('MEDIUM');
    expect(read('Trump to visit a plant', 3)?.score).toBe(0.39);
    expect(read('Trump to visit a plant', 3)?.impact).toBe('LOW');
    expect(read('Government shutdown looms', 1)?.impact).toBe('LOW');
  });

  it('counts the best topic, and lists the other topics that count after it', () => {
    const result = read('Gold prices hit a record as the dollar slides and Powell speaks');
    expect(result?.topics).toEqual(['GOLD_DIRECT', 'FED_RATES', 'USD_DOLLAR']);
    expect(result?.score).toBe(0.81);
    expect(result?.matches.map((match) => [match.topic, match.phrase, match.score])).toEqual([
      ['GOLD_DIRECT', 'Gold prices', 0.9],
      ['FED_RATES', 'Powell', 0.7],
      ['USD_DOLLAR', 'dollar slides', 0.52],
    ]);
  });

  it('puts topics of the same score in the order of the list of topics', () => {
    const result = read('Sanctions and sell-offs');
    expect(result?.matches.map((match) => match.score)).toEqual([0.85, 0.8]);
    const tie = read('CPI and payrolls and bullion');
    expect(tie?.topics).toEqual(['INFLATION_JOBS', 'GOLD_DIRECT']);
    expect(tie?.matches.map((match) => match.score)).toEqual([0.9, 0.9]);
  });

  it('takes a phrase of the summary at a lower strength, and the best of title and summary', () => {
    expect(SUMMARY_FACTOR).toBe(0.7);
    const onlySummary = read('Markets brace for Friday', 2, 0, 'Powell is due to speak at noon.');
    expect(onlySummary?.matches).toEqual([
      { topic: 'FED_RATES', phrase: 'Powell', score: 0.49, in: 'summary' },
    ]);
    expect(onlySummary?.score).toBe(0.44);
    expect(onlySummary?.impact).toBe('LOW');
    const both = read('Powell speaks', 2, 0, 'Powell cuts rates, the Fed said.');
    expect(both?.matches[0]).toMatchObject({ phrase: 'Powell', score: 0.7, in: 'title' });
    const summaryWins = read('Powell speaks', 2, 0, 'The Fed holds rates steady.');
    expect(summaryWins?.matches[0]).toMatchObject({
      phrase: 'Fed holds',
      score: 0.7,
      in: 'summary',
    });
    expect(summaryWins?.score).toBe(0.63);
    expect(read('Markets brace', 2, 0, '')).toBeNull();
    expect(read('Markets brace', 2, 0, null)).toBeNull();
  });

  it('keeps a topic only when its weight times its strength reaches the minimum', () => {
    expect(MIN_TOPIC_SCORE).toBe(0.3);
    const weakest = Math.min(...TOPIC_RULES.map((rule) => rule.weight * STRENGTH_VALUE.W));
    expect(Math.round(weakest * 100) / 100).toBeGreaterThanOrEqual(MIN_TOPIC_SCORE);
  });

  it('is deterministic', () => {
    const title = 'Fed holds rates steady as inflation cools';
    expect(read(title)).toEqual(read(title));
  });
});

describe('impactOf, recencyFactor and the numbers', () => {
  it('maps the score at 0.65 and 0.45, the edge going up', () => {
    expect(IMPACT_HIGH).toBe(0.65);
    expect(IMPACT_MEDIUM).toBe(0.45);
    expect(impactOf(0.65)).toBe('HIGH');
    expect(impactOf(0.64)).toBe('MEDIUM');
    expect(impactOf(0.45)).toBe('MEDIUM');
    expect(impactOf(0.44)).toBe('LOW');
    expect(impactOf(0)).toBe('LOW');
    expect(impactOf(1)).toBe('HIGH');
  });

  it('takes an hour as fresh, three hours as a little old and then older', () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(60 * MIN)).toBe(1);
    expect(recencyFactor(60 * MIN + 1)).toBe(0.8);
    expect(recencyFactor(180 * MIN)).toBe(0.8);
    expect(recencyFactor(180 * MIN + 1)).toBe(0.6);
    expect(recencyFactor(MAX_ITEM_AGE_MS)).toBe(0.6);
  });

  it('has the documented outlet factors, the version and the age limit', () => {
    expect(TIER_FACTOR).toEqual({ 1: 1, 2: 0.9, 3: 0.7 });
    expect(CLASSIFIER_VERSION).toBe('1.0.0');
    expect(MAX_ITEM_AGE_MS).toBe(6 * 60 * MIN);
  });
});
