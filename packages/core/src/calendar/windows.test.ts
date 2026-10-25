import { describe, expect, it } from 'vitest';

import type { NewsWindowSpec } from '../context/macro';
import { mergeNewsWindows, opensWindow } from './windows';

const SPEC: NewsWindowSpec = { before: 45, after: 20, impact: ['high'], currency: ['USD'] };

describe('mergeNewsWindows', () => {
  it('is the longest window of the specs, with every impact and currency they count', () => {
    const merged = mergeNewsWindows([
      SPEC,
      { before: 30, after: 60, impact: ['high', 'medium'], currency: ['USD', 'EUR'] },
    ]);
    expect(merged).toEqual({
      before: 45,
      after: 60,
      impact: ['high', 'medium'],
      currency: ['USD', 'EUR'],
    });
  });

  it('is the spec itself for one, and refuses none', () => {
    expect(mergeNewsWindows([SPEC])).toEqual(SPEC);
    expect(() => mergeNewsWindows([])).toThrow(RangeError);
  });
});

describe('opensWindow', () => {
  const event = { id: 'a', scheduledAt: 1, importance: 'high' as const, currency: 'USD' };

  it('needs both the impact and the currency of the window', () => {
    expect(opensWindow(event, SPEC)).toBe(true);
    expect(opensWindow({ ...event, importance: 'medium' }, SPEC)).toBe(false);
    expect(opensWindow({ ...event, currency: 'EUR' }, SPEC)).toBe(false);
    expect(opensWindow({ ...event, currency: null }, SPEC)).toBe(false);
  });
});
