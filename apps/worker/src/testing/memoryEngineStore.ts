import type {
  BucketDims,
  EngineStateDoc,
  EngineTimeframe,
  ExplanationEvidence,
  Rejection,
} from '@vmgs/core';

import type {
  CandleCursor,
  EngineControls,
  EngineStore,
  OpenSignalFacts,
  StoredCandle,
  StoredQuote,
} from '../engine/store';

const EMPTY: ExplanationEvidence = {
  scope: 'FORWARD',
  level: 4,
  n: 0,
  wins: 0,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
};

/** `EngineStore` in memory, for the unit tests of the decision loop. */
export class MemoryEngineStore implements EngineStore {
  readonly candles: Record<EngineTimeframe, StoredCandle['candle'][]> = {
    '5m': [],
    '15m': [],
    '1h': [],
  };
  readonly quotes: StoredQuote[] = [];
  open: OpenSignalFacts[] = [];
  controlsNow: EngineControls = { paused: false, modes: {} };
  evidenceOf: (dims: BucketDims) => ExplanationEvidence = () => EMPTY;
  readonly rejections: { at: number; rejection: Rejection }[] = [];
  readonly states: { state: EngineStateDoc; at: number }[] = [];
  readonly evidenceAsked: BucketDims[] = [];
  readonly cursors: CandleCursor[] = [];
  /** Makes the next write of a rejection fail. */
  failRejection = false;

  add(tf: EngineTimeframe, candle: StoredCandle['candle']): void {
    this.candles[tf].push(candle);
    this.candles[tf].sort((a, b) => a.openTime - b.openTime);
  }

  history(limits: Readonly<Record<EngineTimeframe, number>>): Promise<StoredCandle[]> {
    const out: StoredCandle[] = [];
    for (const tf of ['5m', '15m', '1h'] as const) {
      for (const candle of this.candles[tf].slice(-limits[tf])) out.push({ tf, candle });
    }
    return Promise.resolve(out);
  }

  after(cursor: CandleCursor, limit: number): Promise<StoredCandle[]> {
    this.cursors.push({ ...cursor });
    const out: StoredCandle[] = [];
    for (const tf of ['5m', '15m', '1h'] as const) {
      const from = cursor[tf];
      for (const candle of this.candles[tf]) {
        if (from === null || candle.openTime > from) out.push({ tf, candle });
      }
    }
    out.sort((a, b) => a.candle.openTime - b.candle.openTime);
    return Promise.resolve(out.slice(0, limit));
  }

  firstQuoteAtOrAfter(ts: number): Promise<StoredQuote | null> {
    const found = this.quotes.filter((quote) => quote.t >= ts).sort((a, b) => a.t - b.t)[0];
    return Promise.resolve(found ?? null);
  }

  controls(_now: number): Promise<EngineControls> {
    return Promise.resolve(this.controlsNow);
  }

  openSignals(): Promise<OpenSignalFacts[]> {
    return Promise.resolve(this.open);
  }

  evidence(dims: BucketDims): Promise<ExplanationEvidence> {
    this.evidenceAsked.push(dims);
    return Promise.resolve(this.evidenceOf(dims));
  }

  recordRejection(at: number, rejection: Rejection): Promise<void> {
    if (this.failRejection) {
      this.failRejection = false;
      return Promise.reject(new Error('the database is not available'));
    }
    this.rejections.push({ at, rejection });
    return Promise.resolve();
  }

  saveState(state: EngineStateDoc, at: number): Promise<void> {
    this.states.push({ state, at });
    return Promise.resolve();
  }
}
