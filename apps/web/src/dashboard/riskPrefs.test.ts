import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RISK,
  MAX_RISK_PCT,
  changeRiskPrefs,
  parseRiskPrefs,
  serializeRiskPrefs,
} from './riskPrefs';

describe('the saved risk preferences', () => {
  it('start as a demo account of 10,000 USD risking half a percent', () => {
    expect(DEFAULT_RISK).toEqual({ balanceUsd: 10_000, riskPct: 0.5 });
    expect(parseRiskPrefs(null)).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs(undefined)).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs('')).toEqual(DEFAULT_RISK);
  });

  it('are what was saved', () => {
    const prefs = { balanceUsd: 2500, riskPct: 1 };
    expect(parseRiskPrefs(serializeRiskPrefs(prefs))).toEqual(prefs);
  });

  it('take the default for what is not JSON, not an object, or a field that is out of range, a field at a time', () => {
    expect(parseRiskPrefs('{not json')).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs('null')).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs('5')).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs('{"balanceUsd":-5,"riskPct":2}')).toEqual({
      balanceUsd: 10_000,
      riskPct: 2,
    });
    expect(parseRiskPrefs('{"balanceUsd":5000,"riskPct":50}')).toEqual({
      balanceUsd: 5000,
      riskPct: 0.5,
    });
    expect(parseRiskPrefs('{"balanceUsd":"5000","riskPct":"2"}')).toEqual(DEFAULT_RISK);
    expect(parseRiskPrefs('{"balanceUsd":5,"riskPct":0}')).toEqual(DEFAULT_RISK);
  });

  it('take a change that is inside the limits, and keep the old number when it is not', () => {
    const base = { balanceUsd: 5000, riskPct: 1 };
    expect(changeRiskPrefs(base, { balanceUsd: 20_000 })).toEqual({
      balanceUsd: 20_000,
      riskPct: 1,
    });
    expect(changeRiskPrefs(base, { riskPct: MAX_RISK_PCT })).toEqual({
      balanceUsd: 5000,
      riskPct: MAX_RISK_PCT,
    });
    expect(changeRiskPrefs(base, { riskPct: MAX_RISK_PCT + 0.1 })).toEqual(base);
    expect(changeRiskPrefs(base, { balanceUsd: 10 })).toEqual(base);
    expect(changeRiskPrefs(base, { balanceUsd: Number.NaN, riskPct: Number.NaN })).toEqual(base);
  });
});
