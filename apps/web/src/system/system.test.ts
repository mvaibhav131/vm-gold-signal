import type { Evidence } from '@vmgs/contracts';
import { NOTIFICATION_KINDS, STRATEGY_KEYS, type StrategyStatus } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../mocks/preferences';
import { mergeSettingsPatch } from '../data/settingsPatch';
import { GATE_KEYS, GATE_TEXT, KIND_LABELS, SELECTABLE_KINDS, orderedKinds } from './alerts';
import {
  MIN_PASSWORD_LENGTH,
  emptyPasswordForm,
  toPasswordRequest,
  validateCode,
  validatePasswordForm,
} from './security';
import { STATUS_LABELS, STATUS_TONE, evidenceLine } from './strategies';
import { SYSTEM_TABS, systemTabFromParams } from './SystemPage';
import { timeZoneMenuSize, timeZoneOptions } from './timezones';

describe('the kinds of message', () => {
  it('are every kind of the notification list except the test, each with a label', () => {
    expect(SELECTABLE_KINDS).toHaveLength(NOTIFICATION_KINDS.length - 1);
    expect(SELECTABLE_KINDS).not.toContain('TEST');
    for (const kind of SELECTABLE_KINDS) expect(KIND_LABELS[kind], kind).toMatch(/\S/);
    expect(new Set(Object.values(KIND_LABELS)).size).toBe(SELECTABLE_KINDS.length);
  });

  it('keep the order of the list, whatever the order they were chosen in, and drop what is not a kind', () => {
    expect(orderedKinds(['SIGNAL_CLOSED', 'SIGNAL_NEW'])).toEqual(['SIGNAL_NEW', 'SIGNAL_CLOSED']);
    expect(orderedKinds(['MONTHLY_REPORT', 'TEST', 'NOT_A_KIND', 'SIGNAL_TP1'])).toEqual([
      'SIGNAL_TP1',
      'MONTHLY_REPORT',
    ]);
    expect(orderedKinds([])).toEqual([]);
    // a kind twice is one kind
    expect(orderedKinds(['SIGNAL_NEW', 'SIGNAL_NEW'])).toEqual(['SIGNAL_NEW']);
  });

  it('are accepted by the settings as they come out', () => {
    const merged = mergeSettingsPatch(defaultSettings(), {
      alerts: { telegram: { kinds: orderedKinds(['SIGNAL_CLOSED', 'SIGNAL_NEW']) } },
    });
    expect(merged.alerts.telegram.kinds).toEqual(['SIGNAL_NEW', 'SIGNAL_CLOSED']);
  });
});

describe('the advisory flags', () => {
  it('are the four of the settings, each with a label and a description', () => {
    expect(GATE_KEYS).toEqual(['newsWindow', 'rollover', 'offHours', 'nearLevel']);
    expect(Object.keys(defaultSettings().advisoryGates)).toEqual([...GATE_KEYS]);
    for (const key of GATE_KEYS) {
      expect(GATE_TEXT[key].label, key).toMatch(/\S/);
      expect(GATE_TEXT[key].description, key).toMatch(/\S/);
    }
  });
});

describe('the merge of a settings patch', () => {
  const base = defaultSettings();

  it('is the settings themselves for a patch that changes nothing the settings have', () => {
    expect(mergeSettingsPatch(base, { locale: 'en' })).toEqual(base);
  });

  it('changes the time zone and the language', () => {
    const next = mergeSettingsPatch(base, { displayTz: 'UTC', locale: 'hinglish' });
    expect([next.displayTz, next.locale]).toEqual(['UTC', 'hinglish']);
    expect(next.alerts).toEqual(base.alerts);
  });

  it('changes one value of Telegram and one of Web Push at a time', () => {
    const next = mergeSettingsPatch(base, {
      alerts: { telegram: { enabled: false }, webpush: { minGrade: 'Very strong' } },
    });
    expect(next.alerts.telegram).toEqual({ ...base.alerts.telegram, enabled: false });
    expect(next.alerts.webpush).toEqual({ ...base.alerts.webpush, minGrade: 'Very strong' });
  });

  it('keeps the other flags, strategies and topics when it changes one', () => {
    const next = mergeSettingsPatch(base, {
      advisoryGates: { nearLevel: 'block' },
      strategyAlerts: { pattern_breakout: 'on' },
      newsAlerts: { topics: { RISK_OFF: 'off' }, minImpact: 'LOW' },
    });
    expect(next.advisoryGates).toEqual({ ...base.advisoryGates, nearLevel: 'block' });
    expect(next.strategyAlerts).toEqual({ ...base.strategyAlerts, pattern_breakout: 'on' });
    expect(next.newsAlerts.topics).toEqual({ ...base.newsAlerts.topics, RISK_OFF: 'off' });
    expect(next.newsAlerts.minImpact).toBe('LOW');
    expect(next.newsAlerts.marketMoves).toBe(base.newsAlerts.marketMoves);
  });

  it('leaves what it was given as it was', () => {
    const before = JSON.stringify(base);
    mergeSettingsPatch(base, {
      strategyAlerts: { trend_pullback: 'off' },
      alerts: { telegram: { kinds: [] } },
    });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('changes every flag, every strategy switch and every other value on its own', () => {
    for (const key of GATE_KEYS) {
      const next = mergeSettingsPatch(base, { advisoryGates: { [key]: 'block' } });
      expect(next.advisoryGates, key).toEqual({ ...base.advisoryGates, [key]: 'block' });
    }
    for (const key of STRATEGY_KEYS) {
      const next = mergeSettingsPatch(base, { strategyAlerts: { [key]: 'off' } });
      expect(next.strategyAlerts, key).toEqual({ ...base.strategyAlerts, [key]: 'off' });
    }
    expect(mergeSettingsPatch(base, { newsAlerts: { marketMoves: 'off' } }).newsAlerts).toEqual({
      ...base.newsAlerts,
      marketMoves: 'off',
    });
    expect(mergeSettingsPatch(base, { newsAlerts: { minImpact: 'MEDIUM' } }).newsAlerts).toEqual({
      ...base.newsAlerts,
      minImpact: 'MEDIUM',
    });
    expect(
      mergeSettingsPatch(base, { alerts: { telegram: { minGrade: 'Strong' } } }).alerts.telegram,
    ).toEqual({ ...base.alerts.telegram, minGrade: 'Strong' });
    expect(
      mergeSettingsPatch(base, { alerts: { telegram: { kinds: ['SIGNAL_NEW'] } } }).alerts.telegram,
    ).toEqual({ ...base.alerts.telegram, kinds: ['SIGNAL_NEW'] });
    expect(
      mergeSettingsPatch(base, { alerts: { webpush: { enabled: true } } }).alerts.webpush,
    ).toEqual({ ...base.alerts.webpush, enabled: true });
    expect(mergeSettingsPatch(base, { displayTz: 'UTC' }).locale).toBe(base.locale);
    expect(mergeSettingsPatch(base, { locale: 'hinglish' }).displayTz).toBe(base.displayTz);
  });
});

describe('the password form', () => {
  const valid = { current: 'preview', next: 'a-long-new-pass', confirm: 'a-long-new-pass' };

  it('has no error when everything is right', () => {
    expect(validatePasswordForm(valid)).toEqual({});
  });

  it('asks for every field', () => {
    expect(validatePasswordForm(emptyPasswordForm)).toEqual({
      current: 'Enter your current password',
      next: 'Use at least 12 characters',
    });
    expect(validatePasswordForm({ ...valid, current: '' }).current).toBe(
      'Enter your current password',
    );
  });

  it('wants at least 12 characters in the new password, exactly 12 is enough', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    const form = (next: string) => ({ current: 'preview', next, confirm: next });
    expect(validatePasswordForm(form('a'.repeat(11))).next).toBe('Use at least 12 characters');
    expect(validatePasswordForm(form('a'.repeat(12)))).toEqual({});
  });

  it('wants the new password to differ from the current one', () => {
    const same = 'preview-password-1';
    expect(validatePasswordForm({ current: same, next: same, confirm: same }).next).toBe(
      'The new password must be different from the current one',
    );
  });

  it('wants the two new passwords to be the same, also when the repeat is empty', () => {
    expect(validatePasswordForm({ ...valid, confirm: 'another-long-one' }).confirm).toBe(
      'The two passwords are not the same',
    );
    expect(validatePasswordForm({ ...valid, confirm: '' }).confirm).toBe(
      'The two passwords are not the same',
    );
  });

  it('builds the request the API expects, without the repeat', () => {
    expect(toPasswordRequest(valid)).toEqual({ current: 'preview', next: 'a-long-new-pass' });
    expect(() => toPasswordRequest({ ...valid, next: 'short' })).toThrow();
  });
});

describe('the code of the authenticator app', () => {
  it('is six digits', () => {
    expect(validateCode('123456')).toBeNull();
    expect(validateCode('000000')).toBeNull();
    for (const bad of ['', '12345', '1234567', '12345a', ' 12345', '12 456']) {
      expect(validateCode(bad), bad).toBe('The code has 6 digits');
    }
  });
});

describe('a strategy', () => {
  it('has a label and a tone for every status, and only a validated one is green', () => {
    const statuses = Object.keys(STATUS_LABELS) as StrategyStatus[];
    expect(statuses).toEqual([
      'RESEARCH',
      'BACKTESTED',
      'FORWARD_TESTING',
      'VALIDATED',
      'PAUSED',
      'DRIFTED',
    ]);
    expect(statuses.filter((status) => STATUS_TONE[status] === 'positive')).toEqual(['VALIDATED']);
    expect(STATUS_LABELS.FORWARD_TESTING).toBe('Forward testing');
  });

  it('shows no percentage under 30 results, only the count and the words', () => {
    expect(
      evidenceLine({
        scope: 'FORWARD',
        level: 3,
        n: 11,
        wins: 5,
        sampleLabel: 'INSUFFICIENT',
        winRate: null,
        ci: null,
        expectancyR: null,
        profitFactor: null,
        tp1Rate: null,
        tp2Rate: null,
      }),
    ).toBe('n=11, insufficient evidence (forward paper trades)');
  });

  it('shows the win rate with its interval from 30 results, and "low sample" under 100', () => {
    const evidence: Evidence = {
      scope: 'BACKTEST_OOS',
      level: 2,
      n: 214,
      wins: 118,
      sampleLabel: 'NORMAL',
      winRate: 0.551,
      ci: [0.484, 0.617],
      expectancyR: 0.13,
      profitFactor: 1.29,
      tp1Rate: 0.523,
      tp2Rate: 0.341,
    };
    expect(evidenceLine(evidence)).toBe(
      '55% win rate (95% CI 48\u201362%), n=214, out-of-sample backtest',
    );
    expect(evidenceLine({ ...evidence, n: 64, sampleLabel: 'LOW_SAMPLE' })).toBe(
      '55% win rate (95% CI 48\u201362%), n=64, out-of-sample backtest, low sample',
    );
  });

  it('says so when there is no evidence at all', () => {
    expect(evidenceLine(null)).toBe('No evidence yet');
    expect(STRATEGY_KEYS).toHaveLength(5);
  });
});

describe('the time zone menu', () => {
  it('starts with the common zones, has every zone once, and holds the current one even if it is not a known zone', () => {
    const options = timeZoneOptions('Asia/Kolkata');
    expect(options.slice(0, 3).map((o) => o.value)).toEqual(['Asia/Kolkata', 'UTC', 'Asia/Dubai']);
    const values = options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('America/New_York');
    expect(timeZoneOptions('Mars/Olympus')[0]).toEqual({
      value: 'Mars/Olympus',
      label: 'Mars/Olympus',
    });
  });

  it('writes a zone with spaces instead of underscores, and keeps the value as the contract wants it', () => {
    const york = timeZoneOptions('UTC').find((o) => o.value === 'America/New_York');
    expect(york).toEqual({ value: 'America/New_York', label: 'America/New York' });
  });

  it('has only named zones, no fixed offsets', () => {
    for (const option of timeZoneOptions('UTC'))
      expect(option.value, option.value).toMatch(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/);
  });

  it('has a current zone that is not a common one once, and first', () => {
    const values = timeZoneOptions('Asia/Karachi').map((o) => o.value);
    expect(values[0]).toBe('Asia/Karachi');
    expect(new Set(values).size).toBe(values.length);
    expect(values.filter((value) => value === 'Asia/Karachi')).toHaveLength(1);
  });

  it('shows exactly the common zones without a search, plus the current setting when it is not one of them', () => {
    expect(timeZoneMenuSize('Asia/Kolkata')).toBe(11);
    expect(timeZoneMenuSize('UTC')).toBe(11);
    expect(timeZoneMenuSize('Asia/Karachi')).toBe(12);
    // the first ones that the menu shows are the current zone and the common zones, nothing else
    const shown = timeZoneOptions('Asia/Karachi').slice(0, timeZoneMenuSize('Asia/Karachi'));
    expect(shown[0]?.value).toBe('Asia/Karachi');
    expect(shown.at(-1)?.value).toBe('Australia/Sydney');
    expect(timeZoneOptions('UTC').at(timeZoneMenuSize('UTC'))?.value).not.toBe('Australia/Sydney');
  });
});

describe('the system tab in the address', () => {
  it('is health by default and for an unknown name, and reads every tab', () => {
    expect(systemTabFromParams(new URLSearchParams(''))).toBe('health');
    expect(systemTabFromParams(new URLSearchParams('tab=nonsense'))).toBe('health');
    expect(systemTabFromParams(new URLSearchParams('tab=ALERTS'))).toBe('health');
    for (const tab of SYSTEM_TABS)
      expect(systemTabFromParams(new URLSearchParams(`tab=${tab}`))).toBe(tab);
    expect(SYSTEM_TABS).toEqual([
      'health',
      'storage',
      'strategies',
      'alerts',
      'display',
      'security',
    ]);
  });
});
