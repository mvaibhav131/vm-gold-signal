import type { GateCode } from '../domain';
import type { GateFailure, GateResult } from './types';

/** A reason on the dashboard in plain words (`waitReasons` of the engine snapshot). */
export interface GateWaitReason {
  readonly code: GateCode;
  readonly label: string;
}

export interface GateLabelContext {
  /** The regime, for REGIME_OK. */
  readonly regime?: string;
}

function joinList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

const regimeWords = (regime: string) => regime.toLowerCase().replace(/_/g, ' ');
const percent = (share: number) => `${String(Math.round(share * 100))}%`;

function dataFreshLabel(reason: GateFailure | undefined, value: number | undefined): string {
  switch (reason) {
    case 'DISCONNECTED':
      return 'Feed disconnected: new signals are blocked';
    case 'NO_TICK':
      return 'No tick received yet: new signals are blocked';
    case 'STALE':
      return `No tick for ${String(Math.round(value ?? 0))} s: new signals are blocked`;
    case 'PROVIDER_STALE':
      return 'The data provider marks its quote as stale: new signals are blocked';
    case 'MARKET_CLOSED':
      return 'Market closed: new signals wait for the reopening';
    case 'MARKET_UNKNOWN':
      return 'Market state unknown: new signals are blocked';
    case 'UNKNOWN':
    case 'COVERAGE':
    case 'MISSING_CANDLE':
    case undefined:
      return 'Data is not fresh: new signals are blocked';
  }
}

/**
 * The words for a gate that failed, in the style of the dashboard ("Spread too high: 0.90 USD").
 * Labels of the advisory flags are made with the explanation (they need names such as the event).
 */
export function gateLabel(result: GateResult, context: GateLabelContext = {}): string {
  if (result.passed) throw new RangeError(`${result.code} passed: it has no reason to wait`);
  const { value, limit, reason } = result;
  switch (result.code) {
    case 'DATA_FRESH':
      return dataFreshLabel(reason, value);
    case 'WARMUP_OK':
      return `Warming up: ${joinList(result.missing ?? [])} candles are still missing`;
    case 'CLOCK_OK':
      return value === undefined
        ? 'Clock difference not known yet: new signals are blocked'
        : `Clock differs from the feed by ${value.toFixed(1)} s: new signals are blocked`;
    case 'SPREAD_OK':
      return value === undefined
        ? 'Spread not known: new signals are blocked'
        : `Spread too high: ${value.toFixed(2)} USD`;
    case 'GAP_RECOVERY_OK':
      if (reason === 'MISSING_CANDLE')
        return 'The latest 5m candle is missing: new signals are blocked';
      if (reason === 'UNKNOWN') return 'No 5m candles yet: new signals are blocked';
      return `Recovering from a data gap: ${String(value ?? 0)} of ${String(limit ?? 0)} clean 5m candles`;
    case 'REGIME_OK':
      return context.regime === undefined
        ? 'Regime: no strategy accepts it'
        : `Regime: ${regimeWords(context.regime)}, no strategy accepts it`;
    case 'STOP_OK':
      if (value === undefined || limit === undefined)
        return 'ATR not known: the stop cannot be checked';
      return value < limit
        ? `Stop too tight: ${value.toFixed(1)} ATR (at least ${String(limit)})`
        : `Stop too wide: ${value.toFixed(1)} ATR (at most ${String(limit)})`;
    case 'TARGET_OK':
      if (value === undefined) return 'ATR not known: the target cannot be checked';
      return `First target too far: ${value.toFixed(1)} ATR (at most ${String(limit ?? 0)})`;
    case 'QUALITY_OK':
      if (value === undefined) return 'No quality score yet';
      if (reason === 'COVERAGE') {
        return `Too little data for a quality score: ${percent(value)} of the weight (at least ${percent(limit ?? 0)})`;
      }
      return `Quality score ${value.toFixed(1)} is below ${String(limit ?? 0)}`;
  }
}

/** One reason per failed gate, in the order of the gates. */
export function gateWaitReasons(
  results: readonly GateResult[],
  context: GateLabelContext = {},
): GateWaitReason[] {
  return results
    .filter((result) => !result.passed)
    .map((result) => ({ code: result.code, label: gateLabel(result, context) }));
}
