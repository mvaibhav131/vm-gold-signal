import { describe, expect, it } from 'vitest';

import { defaultSettingRows } from './settings';

describe('defaultSettingRows', () => {
  it('has one row per key of app_settings (03_Data_Model)', () => {
    expect(defaultSettingRows().map((row) => row.key)).toEqual([
      'displayTz',
      'locale',
      'alerts',
      'advisoryGates',
      'strategyAlerts',
      'newsAlerts',
      'engine',
    ]);
  });

  it('stores every value as JSON text', () => {
    for (const row of defaultSettingRows()) {
      expect(typeof row.value).toBe('string');
      expect(() => JSON.parse(row.value) as unknown).not.toThrow();
    }
    expect(JSON.parse(defaultSettingRows()[0]?.value ?? '')).toBe('Asia/Kolkata');
  });
});
