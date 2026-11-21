/**
 * The demo account that the position size of a signal is worked out for. It is the owner's choice and stays in this browser (the
 * system never places an order, and no server needs to know the balance): a signal has the same levels whatever the account.
 */
export interface RiskPrefs {
  /** The balance the risk is a share of, in USD. */
  readonly balanceUsd: number;
  /** What one trade may lose at its stop, in percent of the balance. */
  readonly riskPct: number;
}

export const RISK_KEY = 'vmgs.risk.v1';
export const DEFAULT_RISK: RiskPrefs = { balanceUsd: 10_000, riskPct: 0.5 };
export const MIN_BALANCE_USD = 100;
export const MAX_BALANCE_USD = 1_000_000_000;
export const MIN_RISK_PCT = 0.05;
/** More than this much of the balance on one trade is not a risk setting, it is a gamble: the screen does not take it. */
export const MAX_RISK_PCT = 5;

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** What was saved, a field at a time: a field that is missing or out of range takes its default and does not spoil the other. */
export function parseRiskPrefs(raw: string | null | undefined): RiskPrefs {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_RISK;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_RISK;
  }
  if (typeof data !== 'object' || data === null) return DEFAULT_RISK;
  const { balanceUsd, riskPct } = data as Record<string, unknown>;
  return {
    balanceUsd: within(balanceUsd, MIN_BALANCE_USD, MAX_BALANCE_USD)
      ? balanceUsd
      : DEFAULT_RISK.balanceUsd,
    riskPct: within(riskPct, MIN_RISK_PCT, MAX_RISK_PCT) ? riskPct : DEFAULT_RISK.riskPct,
  };
}

export function serializeRiskPrefs(prefs: RiskPrefs): string {
  return JSON.stringify(prefs);
}

/** The prefs with the changes that are inside the limits; a number outside them is not taken. */
export function changeRiskPrefs(prefs: RiskPrefs, change: Partial<RiskPrefs>): RiskPrefs {
  return {
    balanceUsd: within(change.balanceUsd, MIN_BALANCE_USD, MAX_BALANCE_USD)
      ? change.balanceUsd
      : prefs.balanceUsd,
    riskPct: within(change.riskPct, MIN_RISK_PCT, MAX_RISK_PCT) ? change.riskPct : prefs.riskPct,
  };
}
