import {
  DEFAULT_LATE_TOLERANCE_MS,
  DEFAULT_MAX_FUTURE_MS,
  fromMilli,
  midMilli,
  toMilli,
  type TickInput,
} from '@vmgs/core';

import type { RawQuote } from './types';

/** Why a quote was not used. Every rejection is counted; none is silent. */
export const REJECT_REASONS = [
  'MALFORMED',
  'UNKNOWN_SYMBOL',
  'BAD_TIME',
  'BAD_PRICE',
  'CROSSED',
  'FUTURE',
  'DUPLICATE',
  'OUT_OF_ORDER',
  'JUMP',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface NormalizerOptions {
  /** The symbols that were subscribed. A quote for any other symbol is rejected. */
  readonly symbols: readonly string[];
  /** A quote stamped further ahead of the receive time than this is garbage (same limit as the candle builder). */
  readonly maxFutureMs: number;
  /** A quote older than the newest accepted one by more than this is out of order (same limit as the candle builder). */
  readonly maxLateMs: number;
  /** A move of the mid price larger than this share between two quotes is suspicious. */
  readonly maxJumpFraction: number;
  /** After a silence longer than this a new price level is believed at once (a weekend gap is real). */
  readonly jumpWindowMs: number;
  /** This many suspicious quotes in a row that agree with each other are a real move: the new level is accepted. */
  readonly jumpConfirmations: number;
  /** "Agree with each other": within this share of the latest suspicious mid price. */
  readonly jumpAgreeFraction: number;
}

export const DEFAULT_NORMALIZER = {
  maxFutureMs: DEFAULT_MAX_FUTURE_MS,
  maxLateMs: DEFAULT_LATE_TOLERANCE_MS,
  maxJumpFraction: 0.01,
  jumpWindowMs: 300_000,
  jumpConfirmations: 3,
  jumpAgreeFraction: 0.002,
} as const;

export type NormalizeResult =
  | { readonly ok: true; readonly tick: TickInput; readonly levelReset: boolean }
  | { readonly ok: false; readonly reason: RejectReason; readonly detail: string };

export interface NormalizerStats {
  readonly accepted: number;
  readonly levelResets: number;
  readonly rejected: Readonly<Record<RejectReason, number>>;
}

/** The latest quotes that count as "already seen" (the server sends its last quote again after a reconnect). */
const RECENT_KEYS = 16;

interface SymbolState {
  newestTs: number;
  lastMid: number | null;
  recent: string[];
  suspects: number[];
}

function emptyRejected(): Record<RejectReason, number> {
  return Object.fromEntries(REJECT_REASONS.map((reason) => [reason, 0])) as Record<
    RejectReason,
    number
  >;
}

const keyOf = (ts: number, bid: number, ask: number) =>
  `${String(ts)}|${String(bid)}|${String(ask)}`;

/**
 * Turns a raw quote into a tick the candle builder and the recorder can trust (01_HLD section 5,
 * step 1): a known symbol, a real time, positive prices rounded to 3 decimals, ask not below bid,
 * not stamped in the future, not seen before, monotonic enough and without an impossible jump.
 */
export class TickNormalizer {
  private readonly options: NormalizerOptions;
  private readonly symbols: ReadonlySet<string>;
  private readonly states = new Map<string, SymbolState>();
  private acceptedCount = 0;
  private resets = 0;
  private readonly rejectedCount = emptyRejected();

  constructor(options: Pick<NormalizerOptions, 'symbols'> & Partial<NormalizerOptions>) {
    this.options = { ...DEFAULT_NORMALIZER, ...options };
    this.symbols = new Set(this.options.symbols);
    if (this.symbols.size === 0) throw new RangeError('at least one symbol is needed');
    if (!(this.options.jumpConfirmations >= 2)) {
      throw new RangeError('jumpConfirmations must be at least 2');
    }
  }

  get stats(): NormalizerStats {
    return {
      accepted: this.acceptedCount,
      levelResets: this.resets,
      rejected: { ...this.rejectedCount },
    };
  }

  /** Counts a message that was not even a quote (the provider could not read it). */
  malformed(): void {
    this.rejectedCount.MALFORMED += 1;
  }

  /**
   * Tells the normalizer which tick was the last one stored, so that the same tick sent again after
   * a restart is a duplicate, and the price level is known from the first quote on.
   */
  prime(tick: TickInput): void {
    const state = this.stateOf(tick.symbol);
    state.newestTs = Math.max(state.newestTs, tick.ts);
    state.lastMid = midMilli(toMilli(tick.bid), toMilli(tick.ask));
    this.remember(state, keyOf(tick.ts, toMilli(tick.bid), toMilli(tick.ask)));
  }

  normalize(quote: RawQuote, rxAt: number): NormalizeResult {
    if (!this.symbols.has(quote.symbol)) {
      return this.reject('UNKNOWN_SYMBOL', `symbol ${quote.symbol} was not subscribed`);
    }
    if (!Number.isFinite(quote.ts) || quote.ts <= 0) {
      return this.reject('BAD_TIME', `source time ${String(quote.ts)} is not a time`);
    }
    if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
      return this.reject('BAD_PRICE', `bid ${String(quote.bid)} / ask ${String(quote.ask)}`);
    }
    const bid = toMilli(quote.bid);
    const ask = toMilli(quote.ask);
    // After rounding to thousandths: zero, negative and sub-tenth-of-a-cent prices are all refused here.
    if (bid <= 0 || ask <= 0) {
      return this.reject('BAD_PRICE', `bid ${String(quote.bid)} / ask ${String(quote.ask)}`);
    }
    if (ask < bid) {
      return this.reject('CROSSED', `ask ${String(quote.ask)} is below bid ${String(quote.bid)}`);
    }
    if (quote.ts - rxAt > this.options.maxFutureMs) {
      return this.reject('FUTURE', `source time is ${String(quote.ts - rxAt)} ms ahead`);
    }

    const state = this.stateOf(quote.symbol);
    const key = keyOf(quote.ts, bid, ask);
    if (state.recent.includes(key)) {
      return this.reject('DUPLICATE', 'this quote was already accepted');
    }
    if (quote.ts < state.newestTs - this.options.maxLateMs) {
      return this.reject(
        'OUT_OF_ORDER',
        `${String(state.newestTs - quote.ts)} ms older than the newest`,
      );
    }

    const mid = midMilli(bid, ask);
    let levelReset = false;
    const jumped =
      state.lastMid !== null &&
      quote.ts - state.newestTs <= this.options.jumpWindowMs &&
      Math.abs(mid - state.lastMid) > state.lastMid * this.options.maxJumpFraction;
    if (jumped) {
      state.suspects.push(mid);
      if (state.suspects.length > this.options.jumpConfirmations) state.suspects.shift();
      if (!this.confirmed(state.suspects)) {
        return this.reject(
          'JUMP',
          `mid ${String(fromMilli(mid))} is ${String(Math.abs(mid - (state.lastMid ?? mid)) / 1000)} from ${String(fromMilli(state.lastMid ?? mid))}`,
        );
      }
      levelReset = true;
      this.resets += 1;
    }
    state.suspects = [];

    state.newestTs = Math.max(state.newestTs, quote.ts);
    state.lastMid = mid;
    this.remember(state, key);
    this.acceptedCount += 1;
    return {
      ok: true,
      levelReset,
      tick: {
        ts: quote.ts,
        rxAt,
        symbol: quote.symbol,
        bid: fromMilli(bid),
        ask: fromMilli(ask),
      },
    };
  }

  private confirmed(suspects: readonly number[]): boolean {
    if (suspects.length < this.options.jumpConfirmations) return false;
    const latest = suspects.at(-1) ?? 0;
    return suspects.every(
      (mid) => Math.abs(mid - latest) <= latest * this.options.jumpAgreeFraction,
    );
  }

  private reject(reason: RejectReason, detail: string): NormalizeResult {
    this.rejectedCount[reason] += 1;
    return { ok: false, reason, detail };
  }

  private remember(state: SymbolState, key: string): void {
    state.recent.push(key);
    if (state.recent.length > RECENT_KEYS) state.recent.shift();
  }

  private stateOf(symbol: string): SymbolState {
    let state = this.states.get(symbol);
    if (!state) {
      state = { newestTs: Number.NEGATIVE_INFINITY, lastMid: null, recent: [], suspects: [] };
      this.states.set(symbol, state);
    }
    return state;
  }
}
