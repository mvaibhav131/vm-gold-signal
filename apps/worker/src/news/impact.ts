import {
  atrLookup,
  atrOfCandles,
  baselineShare,
  impactSampleOf,
  ordinaryWindows,
  sessionAt,
  sessionShares,
  timeOf,
  IMPACT_TICK_TOLERANCE_MS,
  IMPACT_WINDOW_MS,
  type HeadlineCluster,
  type NewsImpact,
  type NewsTopic,
  type Session,
} from '@vmgs/core';

import type { ImpactStore, MarketReader } from './store';

/** A story is measured once its 10 minutes are over and the last ticks of them are stored. */
export const IMPACT_READY_MS = IMPACT_WINDOW_MS + 10_000;
/** A story is looked at for this long after it, then forgotten (the worker was down for longer, or there are no ticks). */
export const IMPACT_LOOKBACK_MS = 24 * 60 * 60_000;
/** The ordinary windows of the baseline are those of the last 30 days. */
export const BASELINE_DAYS = 30;
/** The baseline is computed again at most this often. */
export const BASELINE_EVERY_MS = 6 * 60 * 60_000;
const ATR_CANDLES = 15;

export interface ImpactMeasurerOptions {
  readonly impact: ImpactStore;
  readonly market: MarketReader;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Measures what gold did after each headline story (02 section 16, "Relevance filter and measured impact"):
 * the signed move 2, 5 and 10 minutes after it and the largest excursion in the 10 minutes, with the ATR(5m) that
 * was known then, kept in `news_impact_samples`; then rebuilds `news_topic_stats` and, from time to time, the
 * baseline: the share of ordinary 10-minute windows of the same sessions in which gold moved as far. A story that
 * cannot be measured (the market was closed, the recorder was down, fewer than 14 candles) is left alone, never guessed.
 */
export class ImpactMeasurer {
  private readonly options: ImpactMeasurerOptions;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log: NonNullable<ImpactMeasurerOptions['log']>;
  private readonly unmeasurable = new Set<string>();
  private baselineAt: number | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: ImpactMeasurerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 30_000;
    this.log = options.log ?? (() => undefined);
  }

  /** One pass. Returns how many stories it measured. */
  async runOnce(): Promise<number> {
    const now = this.now();
    const waiting = await this.options.impact.unmeasured(
      now - IMPACT_LOOKBACK_MS,
      now - IMPACT_READY_MS,
    );
    let measured = 0;
    for (const story of waiting) {
      if (this.unmeasurable.has(story.id)) continue;
      if (await this.measure(story)) measured += 1;
      else this.unmeasurable.add(story.id);
    }
    if (measured > 0) await this.options.impact.rebuildStats(now);
    if (measured > 0 && (this.baselineAt === null || now - this.baselineAt >= BASELINE_EVERY_MS)) {
      await this.refreshBaseline(now);
    }
    return measured;
  }

  private async measure(story: HeadlineCluster): Promise<boolean> {
    const at = timeOf(story);
    const ticks = await this.options.market.ticks(
      at - IMPACT_TICK_TOLERANCE_MS,
      at + IMPACT_WINDOW_MS,
    );
    const sample = impactSampleOf(ticks, at);
    if (sample === null) return false;
    const atr5 = atrOfCandles(await this.options.market.closedCandles('5m', at, ATR_CANDLES));
    if (atr5 === null || !(atr5 > 0)) return false;
    return this.options.impact.saveSample({
      clusterId: story.id,
      topics: story.topics,
      impact: story.impact,
      publishedAt: at,
      session: sessionAt(at),
      atr5: round3(atr5),
      move2m: sample.move2m,
      move5m: sample.move5m,
      move10m: sample.move10m,
      maxAbs10m: sample.maxAbs10m,
    });
  }

  /** The baseline of every row of the statistics: ordinary windows of the last 30 days, weighted by session. */
  async refreshBaseline(now: number = this.now()): Promise<number> {
    const from = now - BASELINE_DAYS * 24 * 60 * 60_000;
    const [minutes, fives, events, sessions] = await Promise.all([
      this.options.market.candlesBetween('1m', from, now),
      this.options.market.candlesBetween('5m', from - ATR_CANDLES * 300_000, now),
      this.options.impact.eventTimes(from - 600_000, now + 600_000),
      this.options.impact.sampleSessions(),
    ]);
    const shares = sessionShares(ordinaryWindows(minutes, atrLookup(fives), events));
    const mix = new Map<
      string,
      { topic: NewsTopic; impact: NewsImpact; counts: Partial<Record<Session, number>> }
    >();
    for (const row of sessions) {
      const key = `${row.topic}|${row.impact}`;
      const entry = mix.get(key) ?? { topic: row.topic, impact: row.impact, counts: {} };
      entry.counts[row.session] = row.n;
      mix.set(key, entry);
    }
    const rows = [...mix.values()].map((entry) => ({
      topic: entry.topic,
      impact: entry.impact,
      baseline: baselineShare(entry.counts, shares),
    }));
    await this.options.impact.saveBaselines(rows);
    this.baselineAt = now;
    this.log('info', 'the baseline of the news statistics was computed', {
      windows: Object.values(shares).reduce((sum, share) => sum + share.windows, 0),
      rows: rows.length,
    });
    return rows.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.log('error', 'the impact measurer could not finish a pass', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.stopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a pass is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}
