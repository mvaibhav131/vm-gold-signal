import type { MacroProximity } from '../context/macro';
import type { Session, Side } from '../domain';
import { roundLevelsAround } from '../levels/roundNumbers';
import type { Zone } from '../levels/zones';
import { REGIME_DEFAULTS } from '../regime/types';
import type { QualityInputs } from '../scoring/groups';
import { lineValueAt, type Trendline } from '../trendlines/lines';
import { roundPrice } from '../trade/round';
import type { TradePlan } from '../trade/types';
import { NEAR_LEVEL_DEFAULTS } from '../gates/nearLevel';
import type { MarketView } from './market';
import type { Candidate, EngineChartObject } from './types';

const iso = (ms: number): string => new Date(ms).toISOString();

/** A trendline or zone agrees with a trade that sits within this many ATR(15m) of it. */
export const CONFLUENCE_ATR = 0.5;
/** The zones drawn on a signal: those within this many ATR(15m) of the entry, the nearest few. */
const CHART_ZONE_ATR = 3;
const CHART_ZONES = 4;

/** Where the newest break of the 5m structure points, as the quality score needs it: with the trade, none, or against it. */
function breakEventOf(side: Side, view: MarketView): 'WITH' | 'NONE' | 'AGAINST' | null {
  if (view.state5 === null) return null;
  const found = view.latestBreak;
  if (found === null) return 'NONE';
  const withTrade = (found.direction === 'UP') === (side === 'BUY');
  return withTrade ? 'WITH' : 'AGAINST';
}

/** How many trendlines and zones agree with the trade: the support line and the zones under a BUY (the resistance ones over a SELL) that the entry sits on or next to. */
export function confluenceOf(side: Side, entry: number, view: MarketView): number | null {
  const atr = view.atr15;
  if (atr === null || !(atr > 0)) return null;
  const reach = CONFLUENCE_ATR * atr;
  const line = side === 'BUY' ? view.support15 : view.resistance15;
  let count = 0;
  if (line !== null && Math.abs(entry - lineValueAt(line, view.openTime)) <= reach) count += 1;
  const role = side === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
  for (const zone of view.zones()) {
    if (zone.role === role && entry >= zone.bottom - reach && entry <= zone.top + reach) count += 1;
  }
  return count;
}

/**
 * The room to the nearest major level ahead of the entry (liquidity levels, zones with three touches or
 * more, round numbers of 50 and 100), as a multiple of the distance to TP1; `NONE` when no level is
 * ahead. The level that the setup sweeps is the reason for the trade, not an obstacle.
 */
export function levelRoomOf(
  side: Side,
  entry: number,
  tp1Distance: number,
  view: MarketView,
  sweptLevelId: string | null,
): number | 'NONE' | null {
  if (!(tp1Distance > 0)) return null;
  const toward = side === 'BUY' ? 1 : -1;
  const ahead: number[] = [];
  const consider = (price: number): void => {
    const distance = (price - entry) * toward;
    if (distance > 0) ahead.push(distance);
  };
  for (const level of view.liquidity) {
    if (level.id !== sweptLevelId) consider(level.price);
  }
  for (const zone of view.zones()) {
    if (zone.touches < NEAR_LEVEL_DEFAULTS.zoneMinTouches) continue;
    consider(side === 'BUY' ? zone.bottom : zone.top);
  }
  for (const round of roundLevelsAround(entry, NEAR_LEVEL_DEFAULTS.roundSteps))
    consider(round.price);
  return ahead.length === 0 ? 'NONE' : Math.min(...ahead) / tp1Distance;
}

/** What the engine knows about the setup when it scores it. */
export interface QualityArgs {
  readonly candidate: Candidate;
  readonly side: Side;
  readonly view: MarketView;
  readonly plan: Pick<TradePlan, 'entry' | 'riskDistance' | 'tp1'>;
  readonly session: Session;
  /** The calendar as it stands; null when the feed is down. */
  readonly proximity: MacroProximity | null;
  readonly newsState: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN';
  /** The spread of the confirming quote. */
  readonly spread: number;
}

/** The facts that the quality score reads (docs/02 section 8.1), worked out from the market and the setup. */
export function qualityInputsOf(args: QualityArgs): QualityInputs {
  const { candidate, side, view, plan, spread } = args;
  const atr5 = view.atr5;
  const candle = view.candle;
  const range = candle.h - candle.l;
  const tp1Distance = Math.abs(plan.tp1 - plan.entry);
  const inputs = view.regime?.inputs ?? null;

  const squeeze: 'RELEASED' | 'NONE' | 'ON' | null =
    inputs === null
      ? null
      : inputs.squeezeDuration > 0
        ? 'ON'
        : inputs.releasedBarsAgo !== null &&
            inputs.releasedBarsAgo < REGIME_DEFAULTS.breakout.withinCandles
          ? 'RELEASED'
          : 'NONE';

  const facts = candidate.source;
  return {
    trend: view.trend,
    structure: {
      state15m: view.state15,
      state5m: view.state5,
      breakEvent: breakEventOf(side, view),
      sweep:
        facts.strategyKey === 'sweep_reversal'
          ? { depthAtr: facts.facts.depthAtr, wickRatio: facts.facts.wickRatio }
          : null,
      confluence: confluenceOf(side, plan.entry, view),
      patternMoveR: facts.strategyKey === 'pattern_breakout' ? facts.facts.measuredMoveR : null,
    },
    trigger: {
      rangeAtr: atr5 === null || !(atr5 > 0) ? null : range / atr5,
      closeLocation: range > 0 ? (candle.c - candle.l) / range : 0.5,
      rsiNow: view.rsi.now,
      rsiExtreme: side === 'BUY' ? view.rsi.lowest : view.rsi.highest,
      macdBars: view.macdRun,
    },
    volatility: { atrPercentile: inputs?.atrPercentile15m ?? null, squeeze },
    execution: {
      spreadPercentile: view.spreadPercentile(spread),
      stopAtr: atr5 === null || !(atr5 > 0) ? null : plan.riskDistance / atr5,
    },
    sessionMacro: {
      session: args.session,
      news: { state: args.newsState, minutesToNext: args.proximity?.minutesToNext ?? null },
    },
    reward: {
      tp1Atr: atr5 === null || !(atr5 > 0) ? null : tp1Distance / atr5,
      levelRoom: levelRoomOf(side, plan.entry, tp1Distance, view, candidate.sweptLevelId),
    },
  };
}

function trendlineObject(line: Trendline, view: MarketView): EngineChartObject {
  return {
    id: line.id,
    type: 'trendline',
    tf: '15m',
    points: [
      { t: iso(line.a.openTime), price: roundPrice(line.a.price) },
      { t: iso(line.b.openTime), price: roundPrice(line.b.price) },
      { t: iso(view.openTime), price: roundPrice(lineValueAt(line, view.openTime)) },
    ],
    meta: { side: line.side, touches: line.touches, confirmed: line.confirmed, score: line.score },
  };
}

function zoneObject(zone: Zone, view: MarketView): EngineChartObject {
  const first = Math.min(...zone.points.map((point) => point.openTime));
  return {
    id: zone.id,
    type: 'zone',
    tf: '15m',
    points: [
      { t: iso(first), price: roundPrice(zone.bottom) },
      { t: iso(view.openTime), price: roundPrice(zone.top) },
    ],
    meta: {
      role: zone.role,
      touches: zone.touches,
      strength: zone.strength,
      flipped: zone.flipped,
      timeframes: [...zone.timeframes],
    },
  };
}

/** The objects that the dashboard draws with the signal and the review explains it with: the 15m trendlines, the zones next to the entry, and the pattern of strategy E. */
export function chartObjectsOf(
  candidate: Candidate,
  entry: number,
  view: MarketView,
): EngineChartObject[] {
  const objects: EngineChartObject[] = [];
  for (const line of [view.support15, view.resistance15]) {
    if (line !== null) objects.push(trendlineObject(line, view));
  }
  const atr = view.atr15;
  if (atr !== null && atr > 0) {
    const near = view
      .zones()
      .map((zone) => ({
        zone,
        distance: Math.max(0, zone.bottom - entry, entry - zone.top),
      }))
      .filter((item) => item.distance <= CHART_ZONE_ATR * atr)
      .sort((a, b) => a.distance - b.distance || b.zone.strength - a.zone.strength)
      .slice(0, CHART_ZONES);
    for (const { zone } of near) objects.push(zoneObject(zone, view));
  }
  const source = candidate.source;
  if (source.strategyKey === 'pattern_breakout') {
    const f = source.facts;
    objects.push({
      id: `pattern:${candidate.setup.setupKey}`,
      type: 'pattern',
      tf: '15m',
      points: [
        { t: iso(f.patternFrom), price: roundPrice(f.level) },
        { t: iso(f.patternTo), price: roundPrice(f.level) },
      ],
      meta: {
        pattern: f.pattern,
        level: f.level,
        target: f.target,
        measuredMoveR: f.measuredMoveR,
      },
    });
  }
  return objects;
}
