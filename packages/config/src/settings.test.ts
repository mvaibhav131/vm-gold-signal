import { NEWS_TOPICS, NOTIFICATION_KINDS, STRATEGY_KEYS } from '@vmgs/core';
import { engineStateSchema, settingsSchema } from '@vmgs/contracts';
import { describe, expect, it } from 'vitest';

import { defaultEngineState, defaultSettings } from './settings';

describe('defaultSettings', () => {
  it('is a valid settings object', () => {
    expect(settingsSchema.safeParse(defaultSettings()).success).toBe(true);
  });

  it('uses the documented defaults', () => {
    const settings = defaultSettings();
    expect(settings.displayTz).toBe('Asia/Kolkata');
    expect(settings.locale).toBe('en');
    expect(settings.alerts.telegram).toMatchObject({ enabled: true, minGrade: 'Moderate' });
    expect(settings.alerts.webpush.enabled).toBe(false);
    expect(settings.newsAlerts.minImpact).toBe('HIGH');
    expect(settings.newsAlerts.marketMoves).toBe('on');
  });

  it('only warns for every advisory flag (rule C10)', () => {
    expect(Object.values(defaultSettings().advisoryGates)).toEqual([
      'warn',
      'warn',
      'warn',
      'warn',
    ]);
  });

  it('switches strategy alerts on for A, B and C and off for D and E', () => {
    expect(defaultSettings().strategyAlerts).toEqual({
      trend_pullback: 'on',
      sweep_reversal: 'on',
      squeeze_retest: 'on',
      trendline_retest: 'off',
      pattern_breakout: 'off',
    });
    expect(Object.keys(defaultSettings().strategyAlerts)).toEqual([...STRATEGY_KEYS]);
  });

  it('turns every news topic and every alert kind on', () => {
    const settings = defaultSettings();
    expect(Object.keys(settings.newsAlerts.topics).sort()).toEqual([...NEWS_TOPICS].sort());
    expect(Object.values(settings.newsAlerts.topics).every((v) => v === 'on')).toBe(true);
    expect(settings.alerts.telegram.kinds).toEqual([...NOTIFICATION_KINDS]);
  });

  it('returns a fresh object every time', () => {
    const a = defaultSettings();
    a.alerts.telegram.kinds.pop();
    expect(defaultSettings().alerts.telegram.kinds).toHaveLength(NOTIFICATION_KINDS.length);
  });
});

describe('defaultEngineState', () => {
  it('is running: the system never pauses itself', () => {
    expect(defaultEngineState()).toEqual({ status: 'RUNNING' });
    expect(engineStateSchema.safeParse({ status: 'RUNNING' }).success).toBe(true);
  });

  it('describes a pause with its start', () => {
    const paused = { status: 'PAUSED', pausedSince: '2026-10-23T06:00:00Z', pausedUntil: null };
    expect(engineStateSchema.safeParse(paused).success).toBe(true);
    expect(engineStateSchema.safeParse({ status: 'PAUSED' }).success).toBe(false);
    expect(
      engineStateSchema.safeParse({ status: 'RUNNING', pausedSince: '2026-10-23T06:00:00Z' })
        .success,
    ).toBe(false);
  });
});
