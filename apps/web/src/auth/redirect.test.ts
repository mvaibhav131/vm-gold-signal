import { describe, expect, it } from 'vitest';

import { safeRedirectTarget } from './redirect';

describe('safeRedirectTarget', () => {
  it('returns to a page inside the app', () => {
    expect(safeRedirectTarget({ from: '/signals' })).toBe('/signals');
    expect(safeRedirectTarget({ from: '/signals/42' })).toBe('/signals/42');
  });

  it('falls back to the dashboard without a usable target', () => {
    expect(safeRedirectTarget(undefined)).toBe('/');
    expect(safeRedirectTarget(null)).toBe('/');
    expect(safeRedirectTarget({})).toBe('/');
    expect(safeRedirectTarget({ from: 42 })).toBe('/');
  });

  it('never leaves the site (open redirect)', () => {
    expect(safeRedirectTarget({ from: '//evil.example.com' })).toBe('/');
    expect(safeRedirectTarget({ from: 'https://evil.example.com' })).toBe('/');
    expect(safeRedirectTarget({ from: '/\\evil.example.com' })).toBe('/');
    expect(safeRedirectTarget({ from: 'javascript:alert(1)' })).toBe('/');
  });

  it('does not send a logged-in visitor back to the login page', () => {
    expect(safeRedirectTarget({ from: '/login' })).toBe('/');
  });
});
