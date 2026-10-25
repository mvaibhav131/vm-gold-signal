import type { NewsTopic } from '../domain';

/** How sure a phrase is that a headline is about the topic: S strong, M medium, W weak. */
export type Strength = 'S' | 'M' | 'W';

export const STRENGTH_VALUE: Readonly<Record<Strength, number>> = { S: 1, M: 0.7, W: 0.4 };

/** One phrase of a topic: a regular expression source, matched on word boundaries and without regard to case unless it says so. */
export interface Keyword {
  readonly pattern: string;
  readonly strength: Strength;
  /** For `Fed` and the like, which would also match an ordinary word in lower case. */
  readonly caseSensitive?: boolean;
}

export interface TopicRule {
  readonly topic: NewsTopic;
  /** How much the topic can move gold: the highest weight is 1. */
  readonly weight: number;
  readonly keywords: readonly Keyword[];
}

const S = (pattern: string, caseSensitive = false): Keyword => ({
  pattern,
  strength: 'S',
  caseSensitive,
});
const M = (pattern: string, caseSensitive = false): Keyword => ({
  pattern,
  strength: 'M',
  caseSensitive,
});
const W = (pattern: string, caseSensitive = false): Keyword => ({
  pattern,
  strength: 'W',
  caseSensitive,
});

const MOVES =
  'rall(?:y|ies|ied)|surg(?:e|es|ed)|slump(?:s|ed)?|fall(?:s)?|fell|jump(?:s|ed)?|hit(?:s)?|top(?:s)?|climb(?:s|ed)?|drop(?:s|ped)?|slid(?:e|es)?|sink(?:s)?|sank|soar(?:s|ed)?|ris(?:e|es)|rose|gain(?:s|ed)?|extend(?:s)?|retreat(?:s)?|steadies|hold(?:s)?|edge(?:s)?|dip(?:s)?|tumble(?:s|d)?';

/** "Dollar" of the United States only: not the Australian, Canadian or any other dollar. */
const USD =
  '(?<!(?:australian|canadian|new zealand|hong kong|singapore|taiwan|zimbabwean|kiwi|aussie)\\s)';

/**
 * The rules of the classifier (02_Signal_Engine section 16): the topics, how far each can move
 * gold (weight) and the phrases that point to it. Every number here is a hypothesis that the
 * measured impact (`news_topic_stats`) is meant to check; changing a rule means a new
 * `CLASSIFIER_VERSION` and new golden tests.
 */
export const TOPIC_RULES: readonly TopicRule[] = [
  {
    topic: 'FED_RATES',
    weight: 1,
    keywords: [
      S('FOMC'),
      S('rate[- ](?:cuts?|hikes?)'),
      S('interest[- ]rate (?:decisions?|cuts?|hikes?)'),
      S('Fed chair(?:man|woman)?'),
      S('Fed (?:holds|cuts|raises|hikes|lowers|keeps|signals|minutes)'),
      S('quantitative (?:easing|tightening)'),
      S('dot plot'),
      S('Jackson Hole'),
      M('Fed', true),
      M('Powell'),
      M('interest rates?'),
      M('rate decision'),
      M('discount rate'),
      M('monetary policy'),
      M('(?:Treasury|bond) yields?'),
      M('Treasuries'),
      W('Federal Reserve'),
      W('yields?'),
      W('central banks?'),
    ],
  },
  {
    topic: 'USD_DOLLAR',
    weight: 0.75,
    keywords: [
      S('dollar index'),
      S('DXY'),
      S('(?:US|U\\.S\\.) dollar'),
      S('greenback'),
      M(
        `${USD}dollar (?:surges?|slides?|falls?|rises?|jumps?|tumbles?|gains?|weakens?|strengthens?|rall(?:y|ies)|drops?|slumps?|sinks?|climbs?)`,
      ),
      M(`(?:stronger|weaker|weak|strong) ${USD}dollar`),
    ],
  },
  {
    topic: 'INFLATION_JOBS',
    weight: 0.9,
    keywords: [
      S('CPI', true),
      S('PCE', true),
      S('PPI', true),
      S('non-?farm'),
      S('payrolls?'),
      S('jobs report'),
      S('jobless claims'),
      S('(?:US|U\\.S\\.) inflation'),
      S('(?:consumer|producer) prices?'),
      S('core inflation'),
      S('unemployment rate'),
      M('inflation'),
      M('unemployment'),
      M('jobs data'),
      M('labou?r market'),
      W('job (?:growth|gains|losses)'),
    ],
  },
  {
    topic: 'GEOPOLITICS_WAR',
    weight: 0.9,
    keywords: [
      S('missiles?'),
      S('air[- ]?strikes?'),
      S('invasion'),
      S('invad(?:e|es|ed|ing)'),
      S('cease-?fire'),
      S('drone strikes?'),
      S('nuclear (?:tests?|threats?|weapons?|strikes?)'),
      S('military strikes?'),
      S('bombing'),
      S('shelling'),
      S('rocket (?:attacks?|fire)'),
      M('war'),
      M('Israel(?:i|is)?'),
      M('Iran(?:ian|ians)?'),
      M('Ukrain(?:e|ian|ians)'),
      M('Taiwan'),
      M('Gaza'),
      M('Houthis?'),
      M('Red Sea'),
      M('Hamas'),
      M('Hezbollah'),
      M('Strait of Hormuz'),
      M('Middle East'),
      M('North Korea'),
      M('troops'),
      M('military'),
      W('Russia(?:n|ns)?'),
      W('conflict'),
      W('tensions?'),
      W('attacks?'),
      W('NATO', true),
    ],
  },
  {
    topic: 'TRUMP_POLICY',
    weight: 0.8,
    keywords: [
      S('tariffs?'),
      S('sanctions?'),
      S('executive order'),
      S('trade (?:deal|war|talks|truce)'),
      M('Trump'),
      M('White House'),
      M('Treasury Secretary'),
      W('Oval Office'),
      W('government shutdown'),
    ],
  },
  {
    topic: 'CENTRAL_BANK_GOLD',
    weight: 0.8,
    keywords: [
      S('central banks?\\b.{0,40}\\bgold'),
      S('gold\\b.{0,40}\\bcentral banks?'),
      S('PBoC\\b.{0,40}\\bgold', true),
      S('gold\\b.{0,40}\\bPBoC', true),
      S('gold (?:reserves|purchases|buying)'),
      M('World Gold Council'),
    ],
  },
  {
    topic: 'GOLD_DIRECT',
    weight: 0.9,
    keywords: [
      S('gold prices?'),
      S('price of gold'),
      S('bullion'),
      S('XAU(?:USD)?', true),
      S('spot gold'),
      S('gold futures'),
      S(`gold (?:${MOVES})`),
      S('record[- ]high (?:for|in) gold'),
      S('gold (?:record|all-time high)'),
      M('gold ETFs?'),
      M('gold-backed'),
      M('gold miners?'),
      M('gold (?:demand|supply|market)'),
      M('SPDR Gold'),
    ],
  },
  {
    topic: 'RISK_OFF',
    weight: 0.85,
    keywords: [
      S('(?:stock|share|equity) market (?:crash|rout|sell-?off|plunge)'),
      S('market (?:crash|rout|meltdown)'),
      S('flash crash'),
      S('sell-?offs?'),
      S('banking crisis'),
      S('bank runs?'),
      S('safe[- ]haven'),
      S('credit crunch'),
      S('(?:sovereign|debt) default'),
      S('circuit breakers?'),
      M('recession'),
      M('meltdown'),
      M('VIX', true),
      M('volatility index'),
      M('stocks? (?:slump|sink|slide|tumble|plunge|fall)s?'),
      M('Wall Street (?:tumbles?|slides?|sinks?|falls?|drops?|slumps?)'),
      W('crash(?:es|ed)?'),
      W('rout'),
      W('plunge[sd]?'),
      W('tumbles?'),
      W('slump(?:s|ed)?'),
      W('default'),
    ],
  },
];
