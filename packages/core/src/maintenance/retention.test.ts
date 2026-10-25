import { describe, expect, it } from 'vitest';

import { DAY_MS, RETENTION_DAYS, cutoffOf } from './retention';

describe('RETENTION_DAYS', () => {
  it('are the rules of 01_HLD section 7', () => {
    expect(RETENTION_DAYS).toEqual({
      ticks: 14,
      candles1m: 180,
      snapshots: 365,
      outboxSent: 30,
      outboxFailed: 90,
      rejections: 30,
      feedIncidents: 90,
      maintenanceRuns: 90,
      loginAttempts: 30,
      securityAudit: 365,
      headlines: 30,
      marketEvents: 365,
    });
  });
});

describe('cutoffOf', () => {
  it('is the time `days` days before now, so what is exactly that old is kept', () => {
    const now = Date.UTC(2026, 9, 25, 3, 30);
    expect(DAY_MS).toBe(86_400_000);
    expect(cutoffOf(now, 30)).toBe(Date.UTC(2026, 8, 25, 3, 30));
    expect(cutoffOf(now, 0)).toBe(now);
    expect(cutoffOf(now, 365)).toBe(Date.UTC(2025, 9, 25, 3, 30));
  });
});
