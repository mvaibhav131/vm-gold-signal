import { TIMEFRAME_MS, type Regime } from '../domain';
import type { StructureBreakSeen } from '../autopsy/types';
import { Ema } from '../indicators/averages';
import { Adx } from '../indicators/directional';
import { Supertrend } from '../indicators/trend';
import { Atr } from '../indicators/volatility';
import { Macd, Rsi } from '../indicators/momentum';
import { MedianBaseline } from '../context/baseline';
import { findEqualLevels } from '../levels/equalLevels';
import { LiquidityBook, equalToLiquidity } from '../levels/liquidity';
import { buildZones, type CloseSample, type Zone, type ZoneSource } from '../levels/zones';
import { RegimeTracker } from '../regime/tracker';
import type { RegimeSnapshot } from '../regime/types';
import type { StructureBreak } from '../structure/breaks';
import { MarketStructure } from '../structure/marketStructure';
import type { LiquidityLevel } from '../structure/sweeps';
import type { Pivot, StructureState } from '../structure/types';
import { TrendlineTracker } from '../trendlines/tracker';
import type { Trendline } from '../trendlines/lines';
import type { QualityTrendFacts } from '../scoring/groups';
import type { EngineCandle, EngineTimeframe } from './types';

/** How many 5m candles a break of structure stays "the newest" for the quality score (two hours, the time stop). */
export const BREAK_RECENT_CANDLES = 24;
/** The window of the RSI extreme of the pullback (the default `rsiLookbackCandles` of strategy A). */
export const RSI_EXTREME_CANDLES = 12;
/** The recent spreads the percentile ranks against: 24 hours of 5m candles. */
export const SPREAD_WINDOW = 288;
/** A percentile of fewer spreads than this is not given. */
const MIN_SPREADS = 30;
/** 15m closes kept for the zones' flip rule: more than the 200 candles a zone looks at. */
const KEPT_CLOSES = 220;
const KEPT_FIVE_TIMES = 64;
/** The regime at the close of each of the last 1000 5m candles (three and a half days) and the last 200 changes of character: what the review of a trade asks for. */
const KEPT_REGIMES = 1000;
const KEPT_BREAKS = 200;

/** The values of the market as of the newest closed 5m candle, in the form the quality score and the gates read them. */
export interface MarketView {
  /** Open time and close of the newest 5m candle. */
  readonly openTime: number;
  readonly close: number;
  readonly candle: EngineCandle;
  readonly atr5: number | null;
  readonly atr15: number | null;
  readonly regime: RegimeSnapshot | null;
  readonly trend: QualityTrendFacts;
  readonly state15: StructureState | null;
  readonly state5: StructureState | null;
  /** The newest BOS or CHoCH of the 5m structure within `BREAK_RECENT_CANDLES`, or null. */
  readonly latestBreak: StructureBreak | null;
  readonly rsi: {
    readonly now: number | null;
    readonly lowest: number | null;
    readonly highest: number | null;
  };
  /** Candles in a row that the MACD histogram has risen (positive) or fallen (negative). */
  readonly macdRun: number | null;
  /** The 24h medians before the newest candle: ATR(5m) and the spread. */
  readonly atrBaseline: number | null;
  readonly spreadBaseline: number | null;
  /** The liquidity levels that apply to the next candle. */
  readonly liquidity: readonly LiquidityLevel[];
  readonly support15: Trendline | null;
  readonly resistance15: Trendline | null;
  /** Rank (0 to 100) of a spread among the last 24 hours of candle spreads; null while there are too few. */
  spreadPercentile(spread: number): number | null;
  /** Support and resistance zones as of now (worked out when asked for). */
  zones(): readonly Zone[];
  /** Open times of the newest 5m candles, oldest first. */
  readonly fiveOpenTimes: readonly number[];
}

const pivotsOf = (structure: MarketStructure): Pivot[] => [
  ...structure.highPivots,
  ...structure.lowPivots,
];

/**
 * Everything that the engine reads from the candles besides what the strategies keep for
 * themselves: the regime, the 1h trend values, the structure of the three timeframes, the liquidity
 * levels, the trendlines, the zones, RSI and MACD of the 5m, and the 24h baselines of ATR and spread.
 *
 * Feed it every closed candle in the order they closed (`mergeByClose`): when candles of several
 * timeframes close together, the 1h first, then the 15m, then the 5m. Everything is streaming and
 * only looks back, so the answer for a candle never changes when later candles arrive.
 */
export class MarketTracker {
  readonly regime = new RegimeTracker();
  readonly structure5 = new MarketStructure();
  readonly structure15 = new MarketStructure();
  readonly structure1h = new MarketStructure();
  readonly book = new LiquidityBook();

  private readonly lines15 = new TrendlineTracker('15m');
  private readonly ema20 = new Ema(20);
  private readonly ema50 = new Ema(50);
  private readonly ema200 = new Ema(200);
  private readonly adx1h = new Adx();
  private readonly supertrend1h = new Supertrend();
  private readonly atr1h = new Atr();
  private readonly ema50History: number[] = [];
  private readonly rsi5 = new Rsi();
  private readonly macd5 = new Macd();
  private readonly atrBaseline5 = new MedianBaseline();
  private readonly spreadBaseline5 = new MedianBaseline();
  private readonly rsiHistory: number[] = [];
  private readonly spreads: number[] = [];
  private readonly closes15: CloseSample[] = [];
  private readonly fiveOpenTimes: number[] = [];
  private macdRun = 0;
  private macdSeen = false;
  private atrMedian: number | null = null;
  private spreadMedian: number | null = null;
  private newestFive: EngineCandle | null = null;
  private levelsBefore: readonly LiquidityLevel[] = [];
  private readonly seen: Record<EngineTimeframe, number> = { '5m': 0, '15m': 0, '1h': 0 };
  private cachedZones: { at: number; zones: readonly Zone[] } | null = null;
  private readonly regimeLog: { at: number; regime: Regime }[] = [];
  private readonly breakLog: StructureBreakSeen[] = [];

  /** The regime at the newest 5m close at or before `ms`; null when the log does not reach back that far or the regime was not known. */
  regimeAt(ms: number): Regime | null {
    for (let i = this.regimeLog.length - 1; i >= 0; i -= 1) {
      const entry = this.regimeLog[i];
      if (entry !== undefined && entry.at <= ms) return entry.regime;
    }
    return null;
  }

  /** The changes of character of the 15m and 1h structure that closed in (`from`, `until`]: from the fill of a trade to its close. */
  changesOfCharacter(from: number, until: number): StructureBreakSeen[] {
    return this.breakLog.filter((item) => item.at > from && item.at <= until);
  }

  private logBreaks(
    tf: '15m' | '1h',
    candle: EngineCandle,
    breaks: readonly StructureBreak[],
  ): void {
    for (const item of breaks) {
      if (item.type !== 'CHOCH') continue;
      this.breakLog.push({
        tf,
        direction: item.direction,
        at: candle.openTime + TIMEFRAME_MS[tf],
        level: item.level,
      });
    }
    while (this.breakLog.length > KEPT_BREAKS) this.breakLog.shift();
  }

  /** How many candles of each timeframe have been fed. */
  get counts(): Readonly<Record<EngineTimeframe, number>> {
    return { ...this.seen };
  }

  /** The liquidity levels that applied to the 5m candle just fed (the strategies read these with that candle). */
  get levelsOfNewestFive(): readonly LiquidityLevel[] {
    return this.levelsBefore;
  }

  push(tf: EngineTimeframe, candle: EngineCandle): void {
    this.seen[tf] += 1;
    if (tf === '1h') this.pushHour(candle);
    else if (tf === '15m') this.pushQuarter(candle);
    else this.pushFive(candle);
  }

  private pushHour(candle: EngineCandle): void {
    this.ema20.update(candle.c);
    const mid = this.ema50.update(candle.c);
    this.ema200.update(candle.c);
    this.adx1h.update(candle);
    this.supertrend1h.update(candle);
    this.atr1h.update(candle);
    this.logBreaks('1h', candle, this.structure1h.update(candle).breaks);
    this.regime.update('1h', candle);
    if (mid !== null) {
      this.ema50History.push(mid);
      if (this.ema50History.length > 4) this.ema50History.shift();
    }
  }

  private pushQuarter(candle: EngineCandle): void {
    this.logBreaks('15m', candle, this.structure15.update(candle).breaks);
    this.lines15.update(candle, this.structure15);
    this.regime.update('15m', candle);
    this.closes15.push({ openTime: candle.openTime, c: candle.c });
    if (this.closes15.length > KEPT_CLOSES) this.closes15.shift();
  }

  private pushFive(candle: EngineCandle): void {
    this.levelsBefore = this.book.levels;
    this.structure5.update(candle, this.levelsBefore);
    const equal = equalToLiquidity(
      findEqualLevels({
        pivots: pivotsOf(this.structure5),
        atr: this.structure5.atr,
        count: this.structure5.count,
        tag: '5m',
      }),
    );
    this.book.update(candle, equal);

    const rsi = this.rsi5.update(candle.c);
    if (rsi !== null) {
      this.rsiHistory.push(rsi);
      if (this.rsiHistory.length > RSI_EXTREME_CANDLES) this.rsiHistory.shift();
    }
    const macd = this.macd5.update(candle.c);
    const change = macd?.histogramChange ?? null;
    if (change !== null) {
      this.macdSeen = true;
      this.macdRun =
        change > 0
          ? this.macdRun > 0
            ? this.macdRun + 1
            : 1
          : change < 0
            ? this.macdRun < 0
              ? this.macdRun - 1
              : -1
            : 0;
    }

    const atr = this.structure5.atr;
    if (atr !== null) this.atrMedian = this.atrBaseline5.update(atr);
    if (candle.spread !== null) {
      this.spreadMedian = this.spreadBaseline5.update(candle.spread);
      this.spreads.push(candle.spread);
      if (this.spreads.length > SPREAD_WINDOW) this.spreads.shift();
    }
    this.fiveOpenTimes.push(candle.openTime);
    if (this.fiveOpenTimes.length > KEPT_FIVE_TIMES) this.fiveOpenTimes.shift();
    this.newestFive = candle;
    this.cachedZones = null;
    const state = this.regime.state;
    if (state !== null) {
      this.regimeLog.push({ at: candle.openTime + TIMEFRAME_MS['5m'], regime: state.regime });
      if (this.regimeLog.length > KEPT_REGIMES) this.regimeLog.shift();
    }
  }

  /** The market as of the newest 5m candle; null before the first one. */
  view(): MarketView | null {
    const candle = this.newestFive;
    if (candle === null) return null;
    const adx = this.adx1h.value;
    const supertrend = this.supertrend1h.value;
    const atr1h = this.atr1h.value;
    const history = this.ema50History;
    const slope =
      history.length === 4 && atr1h !== null && atr1h > 0
        ? ((history[3] ?? 0) - (history[0] ?? 0)) / atr1h
        : null;

    const newestIndex = this.structure5.count - 1;
    const bos = this.structure5.lastBos;
    const choch = this.structure5.lastChoch;
    const newer = bos !== null && (choch === null || bos.index >= choch.index) ? bos : choch;
    const latestBreak =
      newer !== null && newestIndex - newer.index < BREAK_RECENT_CANDLES ? newer : null;

    const rsi = this.rsiHistory;
    const spreads = this.spreads;
    const lines = this.lines15.value;
    const atr15 = this.structure15.atr;
    const snapshot = this.regime.state;

    return {
      openTime: candle.openTime,
      close: candle.c,
      candle,
      atr5: this.structure5.atr,
      atr15,
      regime: snapshot,
      trend: {
        ema20: this.ema20.value,
        ema50: this.ema50.value,
        ema200: this.ema200.value,
        ema50SlopeAtr: slope,
        adx: adx?.adx ?? null,
        plusDI: adx?.plusDI ?? null,
        minusDI: adx?.minusDI ?? null,
        supertrend: supertrend?.direction ?? null,
      },
      state15: this.structure15.state,
      state5: this.structure5.state,
      latestBreak,
      rsi: {
        now: this.rsi5.value,
        lowest: rsi.length === 0 ? null : Math.min(...rsi),
        highest: rsi.length === 0 ? null : Math.max(...rsi),
      },
      macdRun: this.macdSeen ? this.macdRun : null,
      atrBaseline: this.atrMedian,
      spreadBaseline: this.spreadMedian,
      liquidity: this.book.levels,
      support15: lines.support,
      resistance15: lines.resistance,
      spreadPercentile: (spread: number) =>
        spreads.length < MIN_SPREADS
          ? null
          : (100 * spreads.filter((value) => value <= spread).length) / spreads.length,
      zones: () => this.zonesNow(atr15),
      fiveOpenTimes: [...this.fiveOpenTimes],
    };
  }

  private zonesNow(atr15: number | null): readonly Zone[] {
    const at = this.newestFive?.openTime ?? 0;
    if (this.cachedZones?.at === at) return this.cachedZones.zones;
    const sources: ZoneSource[] = [
      { tf: '5m', pivots: pivotsOf(this.structure5), count: this.structure5.count },
      { tf: '15m', pivots: pivotsOf(this.structure15), count: this.structure15.count },
      { tf: '1h', pivots: pivotsOf(this.structure1h), count: this.structure1h.count },
    ];
    const zones = buildZones({ sources, closes: this.closes15, atr: atr15 });
    this.cachedZones = { at, zones };
    return zones;
  }

  /** The length of a 5m candle: the decision comes this long after its open. */
  static readonly FIVE_MS = TIMEFRAME_MS['5m'];
}
