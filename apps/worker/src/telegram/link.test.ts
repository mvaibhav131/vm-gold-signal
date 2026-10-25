import { describe, expect, it } from 'vitest';

import {
  checkLink,
  formatLinkCode,
  issueLink,
  LINK_MAX_ATTEMPTS,
  LINK_TTL_MS,
  newLinkCode,
} from './link';

const NOW = 1_800_000_000_000;

describe('newLinkCode', () => {
  it('is eight digits, also with leading zeros', () => {
    for (let i = 0; i < 200; i += 1) expect(newLinkCode()).toMatch(/^\d{8}$/);
    expect(newLinkCode(() => 42)).toBe('00000042');
    expect(newLinkCode(() => 0)).toBe('00000000');
  });

  it('draws from all 10^8 codes', () => {
    const asked: [number, number][] = [];
    newLinkCode((min, max) => {
      asked.push([min, max]);
      return 7;
    });
    expect(asked).toEqual([[0, 100_000_000]]);
  });

  it('does not repeat itself', () => {
    expect(new Set(Array.from({ length: 50 }, () => newLinkCode())).size).toBeGreaterThan(45);
  });
});

describe('the limits of a code', () => {
  it('are ten minutes and five wrong guesses (04_API_and_Notifications)', () => {
    expect(LINK_TTL_MS).toBe(10 * 60 * 1000);
    expect(LINK_MAX_ATTEMPTS).toBe(5);
  });
});

describe('formatLinkCode', () => {
  it('puts a dash in the middle', () => {
    expect(formatLinkCode('01234567')).toBe('0123-4567');
  });
});

describe('issueLink', () => {
  it('keeps a hash, not the code, and a ten minute life', () => {
    const link = issueLink('12345678', NOW);
    expect(link.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(link)).not.toContain('12345678');
    expect(link.expiresAt).toBe(NOW + LINK_TTL_MS);
    expect(LINK_TTL_MS).toBe(600_000);
    expect(link.attempts).toBe(0);
  });

  it('hashes two codes differently', () => {
    expect(issueLink('12345678', NOW).hash).not.toBe(issueLink('12345679', NOW).hash);
  });
});

describe('checkLink', () => {
  const link = issueLink('12345678', NOW);

  it('accepts the code', () => {
    expect(checkLink(link, '12345678', NOW + 1000)).toEqual({ ok: true });
  });

  it('accepts it until the last millisecond and refuses it from the expiry on', () => {
    expect(checkLink(link, '12345678', NOW + LINK_TTL_MS - 1).ok).toBe(true);
    expect(checkLink(link, '12345678', NOW + LINK_TTL_MS)).toEqual({
      ok: false,
      reason: 'expired',
      next: null,
    });
  });

  it('forgets an expired code even when it was right', () => {
    const result = checkLink(link, '00000000', NOW + LINK_TTL_MS + 5);
    expect(result).toMatchObject({ ok: false, reason: 'expired', next: null });
  });

  it('counts a wrong guess', () => {
    expect(checkLink(link, '87654321', NOW)).toEqual({
      ok: false,
      reason: 'wrong',
      next: { ...link, attempts: 1 },
    });
  });

  it('burns the code at the last wrong guess', () => {
    let state = link;
    for (let i = 1; i < LINK_MAX_ATTEMPTS; i += 1) {
      const result = checkLink(state, '00000001', NOW);
      expect(result).toMatchObject({ ok: false, reason: 'wrong' });
      if (result.ok || result.next === null) throw new Error('the code was burnt too early');
      expect(result.next.attempts).toBe(i);
      state = result.next;
    }
    expect(checkLink(state, '00000001', NOW)).toEqual({ ok: false, reason: 'wrong', next: null });
  });

  it('still accepts the right code after four wrong guesses', () => {
    const four = { ...link, attempts: LINK_MAX_ATTEMPTS - 1 };
    expect(checkLink(four, '12345678', NOW)).toEqual({ ok: true });
  });
});
