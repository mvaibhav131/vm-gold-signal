import {
  CAUSE_WINDOW_MS,
  MOVE_COOLDOWN_MS,
  MOVE_WINDOW_5M_MS,
  TRADED_SYMBOL,
  atrOfCandles,
  detectMove,
  headlineFeedHealth,
  marketMoveRows,
  newsFeedState,
  possibleCauses,
  type AlertSettings,
  type MoveDetection,
  type OpenSignalLine,
  type TickInput,
  type TickPoint,
} from '@vmgs/core';

import type { OutboxStore } from '../alerts/store';
import type { UnclassifiedBuffer } from './buffer';
import type { MarketReader, MoveStore, NewsStore } from './store';

/** The ticks are kept for a little longer than the longest window of the detector. */
const KEEP_MS = MOVE_WINDOW_5M_MS + 60_000;
/** The ATR is read from the stored candles this often. */
export const ATR_REFRESH_MS = 60_000;
const ATR_CANDLES = 15;
/** A tick buffer has no use beyond this many entries (a few ticks a second for six minutes). */
const KEEP_MAX = 20_000;

export interface MarketMoveDetectorOptions {
  readonly market: Pick<MarketReader, 'ticks' | 'closedCandles'>;
  readonly news: Pick<NewsStore, 'sources' | 'clustersSince'>;
  readonly moves: MoveStore;
  readonly buffer: UnclassifiedBuffer;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly settings: () => Promise<AlertSettings>;
  /** The open signals with their result now, for the last line of the message. */
  readonly open: () => Promise<OpenSignalLine[]>;
  readonly onQueued?: () => void;
  readonly symbol?: string;
  readonly now?: () => number;
  readonly checkMs?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

/**
 * Watches the ticks the recorder stores for a sudden move of gold (02 section 16): at least 2.0 x ATR(5m)
 * within 5 minutes or 3.0 x ATR(1m) within one. A move is kept in `market_events` with the headlines that were
 * around it (frozen, as possible causes only), and told as MARKET_MOVE unless the owner switched that off. After
 * a move there is a pause of 10 minutes. It never blocks a signal and never creates one.
 */
export class MarketMoveDetector {
  private readonly options: MarketMoveDetectorOptions;
  private readonly now: () => number;
  private readonly symbol: string;
  private readonly checkMs: number;
  private readonly log: NonNullable<MarketMoveDetectorOptions['log']>;
  private ticks: TickPoint[] = [];
  private atr5: number | null = null;
  private atr1: number | null = null;
  private atrAt: number | null = null;
  private lastMoveAt: number | null = null;
  private lastMoveLoaded = false;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: MarketMoveDetectorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.symbol = options.symbol ?? TRADED_SYMBOL;
    this.checkMs = options.checkMs ?? 5_000;
    this.log = options.log ?? (() => undefined);
  }

  /** The ticks the recorder has stored (its `onPersistedTicks` hook). Only the traded symbol counts. */
  onTicks(ticks: readonly TickInput[]): void {
    for (const tick of ticks) {
      if (tick.symbol === this.symbol)
        this.ticks.push({ ts: tick.ts, bid: tick.bid, ask: tick.ask });
    }
    if (this.ticks.length > KEEP_MAX) this.ticks = this.ticks.slice(this.ticks.length - KEEP_MAX);
  }

  /** The detection of one look at the ticks; the move that was kept, or null. */
  async check(): Promise<MoveDetection | null> {
    const now = this.now();
    this.ticks = this.ticks.filter((tick) => now - tick.ts <= KEEP_MS);
    if (!this.lastMoveLoaded) {
      this.lastMoveAt = await this.options.moves.lastMoveAt();
      this.lastMoveLoaded = true;
    }
    if (this.lastMoveAt !== null && now - this.lastMoveAt < MOVE_COOLDOWN_MS) return null;
    await this.refreshAtr(now);
    const detection = detectMove(this.ticks, now, this.atr5, this.atr1);
    if (detection === null) return null;
    await this.keep(detection, now);
    return detection;
  }

  /** Reads the ticks of the last 5 minutes from the database, so that a restart does not blind the detector. */
  async warmUp(): Promise<void> {
    const now = this.now();
    const stored = await this.options.market.ticks(now - KEEP_MS, now);
    const known = new Set(this.ticks.map((tick) => tick.ts));
    this.ticks = [...stored.filter((tick) => !known.has(tick.ts)), ...this.ticks].sort(
      (a, b) => a.ts - b.ts,
    );
  }

  private async refreshAtr(now: number): Promise<void> {
    if (this.atrAt !== null && now - this.atrAt < ATR_REFRESH_MS) return;
    try {
      this.atr5 = atrOfCandles(await this.options.market.closedCandles('5m', now, ATR_CANDLES));
      this.atr1 = atrOfCandles(await this.options.market.closedCandles('1m', now, ATR_CANDLES));
      this.atrAt = now;
    } catch (error) {
      this.log('error', 'the ATR for the move detector could not be read', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async keep(detection: MoveDetection, now: number): Promise<void> {
    const { news, buffer } = this.options;
    const [sources, stories] = await Promise.all([
      news.sources(),
      news.clustersSince(detection.at - CAUSE_WINDOW_MS),
    ]);
    const causes = possibleCauses(stories, buffer.items(), detection.at);
    const feed = newsFeedState(headlineFeedHealth(sources, now));
    const last = this.ticks[this.ticks.length - 1];
    const spread = last === undefined ? null : Math.round((last.ask - last.bid) * 1000) / 1000;

    const id = await this.options.moves.insertMove({
      kind: detection.kind,
      detectedAt: detection.at,
      windowS: detection.windowS,
      moveUsd: detection.moveUsd,
      moveAtr: detection.moveAtr,
      spread,
      headlines: causes.map((cause) => cause.headline),
      meta: { basis: detection.basis, atr: detection.atr, feed },
    });
    this.lastMoveAt = detection.at;
    this.log('info', 'a sudden move of gold was detected', {
      id,
      kind: detection.kind,
      moveUsd: detection.moveUsd,
      moveAtr: detection.moveAtr,
      basis: detection.basis,
      causes: causes.length,
    });
    try {
      const settings = await this.options.settings();
      const open = await this.options.open().catch((): OpenSignalLine[] => []);
      const rows = marketMoveRows({ detection, spread, causes, feed, open }, id, settings, now);
      if ((await this.options.outbox.enqueue(rows, now)) > 0) this.options.onQueued?.();
    } catch (error) {
      this.log('error', 'the alert of a sudden move could not be queued', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    await this.warmUp().catch((error: unknown) => {
      this.log('error', 'the move detector could not read the recent ticks', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    while (this.running) {
      try {
        await this.check();
      } catch (error) {
        this.log('error', 'the move detector could not finish a look', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.stopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.checkMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a look is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}
