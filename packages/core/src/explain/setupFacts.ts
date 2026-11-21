import type {
  ConfluenceFacts,
  ConfluenceVote,
  HourlyTrendFacts,
  PatternBreakoutFacts,
  PullbackFacts,
  SqueezeFacts,
  SweepFacts,
  TrendlineRetestFacts,
} from '../strategies';
import { CONFLUENCE_VOTES } from '../strategies';
import { atrText, fixedText, percentText, plainRText, priceText } from './format';
import { PATTERN_TEXT } from './names';
import type { ExplanationFact } from './types';

/** The facts of the strategy that made the setup, with the strategy they belong to. */
export type SetupSource =
  | { readonly strategyKey: 'trend_pullback'; readonly facts: PullbackFacts }
  | { readonly strategyKey: 'sweep_reversal'; readonly facts: SweepFacts }
  | { readonly strategyKey: 'squeeze_retest'; readonly facts: SqueezeFacts }
  | { readonly strategyKey: 'trendline_retest'; readonly facts: TrendlineRetestFacts }
  | { readonly strategyKey: 'pattern_breakout'; readonly facts: PatternBreakoutFacts }
  | { readonly strategyKey: 'hourly_trend'; readonly facts: HourlyTrendFacts }
  | { readonly strategyKey: 'confluence'; readonly facts: ConfluenceFacts };

const VOTE_TEXT: Readonly<Record<ConfluenceVote, string>> = {
  TREND_1H: '1h trend',
  TREND_15M: '15m trend',
  EMA_STACK_5M: '5m EMA 20/50',
  RSI: 'RSI',
  MACD: 'MACD',
  ADX: 'ADX',
  DAY_MEAN: 'day mean',
  BREAKOUT: '6-candle breakout',
  NOT_STRETCHED: 'not stretched',
};

/** The lines a strategy adds to the structure group and to the trigger group (its own rules, in numbers). */
export interface SetupFactLines {
  readonly structure: ExplanationFact[];
  readonly trigger: ExplanationFact[];
}

const ZONE_TEXT = {
  EMA: 'EMA zone',
  FIB: 'Fibonacci zone',
  'EMA+FIB': 'EMA and Fibonacci zone',
} as const;

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
const candlesAgo = (n: number): string => `${String(n)} candle${n === 1 ? '' : 's'} ago`;

/** How the retest candle behaved against the broken level: `held 4018.000: stayed 0.20 x ATR away, wick 40%`. */
function retestText(level: number, distanceAtr: number, wickRatio: number): string {
  const reach =
    distanceAtr >= 0
      ? `stayed ${fixedText(distanceAtr, 2)} x ATR away`
      : `went ${fixedText(-distanceAtr, 2)} x ATR through it`;
  return `held ${priceText(level)}: ${reach}, wick ${percentText(wickRatio)}`;
}

function pullbackLines(f: PullbackFacts): SetupFactLines {
  const structure: ExplanationFact[] = [
    {
      label: 'Pullback',
      value: `${priceText(f.legStart.price)} \u2192 ${priceText(f.legExtreme)}, ${ZONE_TEXT[f.zone]}`,
    },
  ];
  if (f.breakLevel !== null) {
    structure.push({
      label: '5m swing level',
      value: `${priceText(f.breakLevel)}, ${f.brokeLevel ? 'closed beyond it' : 'not broken yet'}`,
    });
  }
  return { structure, trigger: [{ label: 'Displacement candle', value: yesNo(f.displacement) }] };
}

function sweepLines(f: SweepFacts): SetupFactLines {
  const trigger: ExplanationFact[] = [
    { label: 'Trigger candle size', value: atrText(f.displacementAtr) },
  ];
  if (f.rsiDivergence) trigger.push({ label: 'RSI divergence', value: 'yes' });
  return {
    structure: [
      {
        label: 'Swept level',
        value: `${priceText(f.level)} (extreme ${priceText(f.sweepLow)}), reclaimed ${candlesAgo(f.candlesSinceReclaim)}`,
      },
      { label: '5m CHoCH', value: `broke ${priceText(f.chochLevel)}` },
      { label: '15m CHoCH', value: yesNo(f.choch15m) },
    ],
    trigger,
  };
}

function squeezeLines(f: SqueezeFacts): SetupFactLines {
  return {
    structure: [
      {
        label: 'Breakout level',
        value: `${priceText(f.level)}, closed ${atrText(f.breakoutCloseAtr)} beyond it, displacement ${atrText(f.breakoutDisplacementAtr)}`,
      },
      {
        label: 'Squeeze (15m)',
        value: `lasted ${String(f.squeezeCandles15m)} candles, released ${candlesAgo(f.candlesSinceRelease15m)}`,
      },
    ],
    trigger: [{ label: 'Retest', value: retestText(f.level, f.retestDistanceAtr, f.wickRatio) }],
  };
}

function trendlineLines(f: TrendlineRetestFacts): SetupFactLines {
  return {
    structure: [
      {
        label: 'Trendline 15m',
        value: `${String(f.touches)} touches, ${priceText(f.lineValue)} at the retest, broken ${candlesAgo(f.candlesSinceBreak)}`,
      },
      {
        label: 'Break',
        value: `${atrText(f.breakBeyondAtr)} beyond the line, body ${percentText(f.breakBodyRatio)} of the candle`,
      },
    ],
    trigger: [
      { label: 'Retest', value: retestText(f.lineValue, f.retestDistanceAtr, f.wickRatio) },
      { label: 'RSI at the retest', value: Math.round(f.rsi) },
    ],
  };
}

function patternLines(f: PatternBreakoutFacts): SetupFactLines {
  return {
    structure: [
      {
        label: 'Pattern 15m',
        value: `${PATTERN_TEXT[f.pattern]}, boundary ${priceText(f.level)}, target ${priceText(f.target)} (${plainRText(f.measuredMoveR)})`,
      },
      {
        label: 'Break',
        value: `${atrText(f.breakBeyondAtr)} beyond the boundary, displacement ${atrText(f.breakDisplacementAtr)}, ${candlesAgo(f.candlesSinceBreak)}`,
      },
    ],
    trigger: [{ label: 'Retest', value: retestText(f.level, f.retestDistanceAtr, f.wickRatio) }],
  };
}

/** The strategy's own facts as explanation lines. Real prices, never mirrored. */
function hourlyTrendLines(f: HourlyTrendFacts): SetupFactLines {
  const stack = f.trend === 'UP' ? 'above' : 'below';
  return {
    structure: [
      {
        label: 'Trend 1h',
        value: `${f.trend === 'UP' ? 'up' : 'down'}: EMA 20 ${priceText(f.emaFast)} ${f.trend === 'UP' ? 'over' : 'under'} EMA 50 ${priceText(f.emaMid)}, close ${priceText(f.hourClose)} ${stack} EMA 200 ${priceText(f.emaSlow)}`,
      },
    ],
    trigger: [
      {
        label: 'Slot decision',
        value: `with the trend, stop ${fixedText(f.stopAtr1h, 1)} x ATR 1h (${priceText(f.atr1h)}) from the price`,
      },
    ],
  };
}

/** The strategy's own facts as explanation lines. Real prices, never mirrored. */
function confluenceLines(f: ConfluenceFacts): SetupFactLines {
  const trendText = (trend: 'UP' | 'DOWN' | null): string =>
    trend === null ? 'none' : trend === 'UP' ? 'up' : 'down';
  return {
    structure: [
      { label: 'Trend 1h / 15m', value: `${trendText(f.trend1h)} / ${trendText(f.trend15m)}` },
      {
        label: 'Stop structure',
        value: `swing ${priceText(f.swingLevel)}, stop ${fixedText(f.stopAtr, 1)} x ATR (${priceText(f.stopUsd)} USD) from the close`,
      },
    ],
    trigger: [
      {
        label: 'Votes',
        value: `${String(f.votes.length)} of ${String(CONFLUENCE_VOTES.length)}: ${f.votes.map((vote) => VOTE_TEXT[vote]).join(', ')}`,
      },
      {
        label: 'Momentum',
        value: `RSI ${fixedText(f.rsi, 0)}, ADX ${fixedText(f.adx, 0)} (+DI ${fixedText(f.plusDI, 0)} / -DI ${fixedText(f.minusDI, 0)}), MACD histogram ${fixedText(f.macdHistogram, 2)}`,
      },
      {
        label: 'Range of the market',
        value: `ATR(5m) ${priceText(f.atr5m)}, ${fixedText(f.atrRatio, 2)} x its average of the day`,
      },
    ],
  };
}

/** The strategy's own facts as explanation lines. Real prices, never mirrored. */
export function setupFacts(source: SetupSource): SetupFactLines {
  switch (source.strategyKey) {
    case 'trend_pullback':
      return pullbackLines(source.facts);
    case 'sweep_reversal':
      return sweepLines(source.facts);
    case 'squeeze_retest':
      return squeezeLines(source.facts);
    case 'trendline_retest':
      return trendlineLines(source.facts);
    case 'pattern_breakout':
      return patternLines(source.facts);
    case 'hourly_trend':
      return hourlyTrendLines(source.facts);
    case 'confluence':
      return confluenceLines(source.facts);
  }
}
