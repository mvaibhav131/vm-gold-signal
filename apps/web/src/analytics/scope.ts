import { STATS_SCOPES, type StatsScope } from '@vmgs/core';

export const SCOPE_PARAM = 'scope';

export const SCOPE_LABELS: Readonly<Record<StatsScope, string>> = {
  FORWARD: 'Forward paper',
  BACKTEST_OOS: 'Backtest out-of-sample',
};

/** What each scope is, in one sentence. A backtest is never a live result and the page says so. */
export const SCOPE_NOTES: Readonly<Record<StatsScope, string>> = {
  FORWARD:
    'Signals the system generated in real time and tracked to their end, with simulated entries and exits. This is the evidence that counts.',
  BACKTEST_OOS:
    'The same rules replayed over past months that were not used to build them. It shows what the rules would have done, not what happened live.',
};

/** The scope in the address bar. Forward is the default and needs no parameter; an unknown value falls back to it. */
export function scopeFromParams(params: URLSearchParams): StatsScope {
  const value = params.get(SCOPE_PARAM);
  return STATS_SCOPES.find((scope) => scope === value) ?? 'FORWARD';
}

export function withScope(params: URLSearchParams, scope: StatsScope): URLSearchParams {
  const next = new URLSearchParams(params);
  if (scope === 'FORWARD') next.delete(SCOPE_PARAM);
  else next.set(SCOPE_PARAM, scope);
  return next;
}
