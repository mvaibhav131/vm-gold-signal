import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { clientKey } from './client';
import { SecretHasher } from './hasher';
import { BusyError, Limiter } from './limiter';
import { DEFAULT_SESSION_POLICY, sessionExpiry } from './policy';
import { RECOVERY_CODE_COUNT, newRecoveryCodes, recoveryCodeHash } from './recovery';
import { DEFAULT_THROTTLE, decideThrottle } from './throttle';
import {
  PUBLIC_ID_SHAPE,
  isSessionToken,
  newSessionToken,
  publicSessionId,
  sessionIdHash,
} from './tokens';
import { TotpReplayGuard, newTotpSecret, totpStep, totpUri } from './totp';

describe('SecretHasher (Argon2id)', () => {
  // small parameters: the tests check the behaviour, not the cost
  const hasher = new SecretHasher(
    { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    new Limiter(2, 4),
  );

  it('makes an argon2id hash that only the right secret opens', async () => {
    const hashed = await hasher.hash('correct horse battery staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hashed, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hashed, 'correct horse battery stapl')).toBe(false);
    expect(await hasher.verify(hashed, '')).toBe(false);
  });

  it('salts: the same secret gives another hash each time', async () => {
    expect(await hasher.hash('same secret, twice')).not.toBe(
      await hasher.hash('same secret, twice'),
    );
  });

  it('says no, and does not throw, for a text that is no hash', async () => {
    expect(await hasher.verify('not a hash', 'x')).toBe(false);
    expect(await hasher.verify('', 'x')).toBe(false);
  });

  it('has one dummy hash that no secret of ours opens', async () => {
    const dummy = await hasher.dummy();
    expect(await hasher.dummy()).toBe(dummy);
    expect(dummy.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(dummy, 'owner')).toBe(false);
  });

  it('uses the parameters it was given', async () => {
    expect(await hasher.hash('x')).toContain('m=1024,t=1,p=1');
  });
});

describe('Limiter', () => {
  it('runs `concurrency` tasks, queues `maxQueue`, and refuses the rest at once', async () => {
    const limiter = new Limiter(2, 1);
    const releases: (() => void)[] = [];
    const started: number[] = [];
    const task = (id: number) => () =>
      new Promise<number>((resolve) => {
        started.push(id);
        releases.push(() => {
          resolve(id);
        });
      });

    const first = limiter.run(task(1));
    const second = limiter.run(task(2));
    const third = limiter.run(task(3)); // waits
    await expect(limiter.run(task(4))).rejects.toBeInstanceOf(BusyError);
    expect(started).toEqual([1, 2]);

    releases[0]?.();
    await first;
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]); // the slot went to the one that waited
    releases[1]?.();
    releases[2]?.();
    expect(await Promise.all([second, third])).toEqual([2, 3]);

    // everything is free again
    const again = limiter.run(() => Promise.resolve('ok'));
    expect(await again).toBe('ok');
  });

  it('frees the slot when a task fails', async () => {
    const limiter = new Limiter(1, 0);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(() => Promise.resolve(1))).toBe(1);
  });
});

describe('session tokens', () => {
  it('are 43 characters of base64url and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(isSessionToken(token)).toBe(true);
  });

  it('are recognised by shape, so that a wrong cookie never reaches the database', () => {
    for (const value of [
      undefined,
      '',
      'short',
      'x'.repeat(42),
      'x'.repeat(44),
      `${'x'.repeat(42)}!`,
      `${'x'.repeat(42)} `,
    ]) {
      expect(isSessionToken(value), String(value)).toBe(false);
    }
  });

  it('are stored as a hash that does not give the token back and differs per token', () => {
    const token = newSessionToken();
    const hash = sessionIdHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(sessionIdHash(token)).toBe(hash);
    expect(sessionIdHash(newSessionToken())).not.toBe(hash);
  });

  it('are hashed under their own label, so that the same text in another table is another hash', () => {
    const token = 'A'.repeat(43);
    expect(sessionIdHash(token)).toBe(
      createHash('sha256').update(`vmgs-session:${token}`).digest('hex'),
    );
    expect(sessionIdHash(token)).not.toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('show 16 characters of the hash as their public id', () => {
    const hash = sessionIdHash(newSessionToken());
    expect(publicSessionId(hash)).toBe(hash.slice(0, 16));
    expect(PUBLIC_ID_SHAPE.test(publicSessionId(hash))).toBe(true);
    expect(PUBLIC_ID_SHAPE.test('ABCDEF0123456789')).toBe(false);
    expect(PUBLIC_ID_SHAPE.test('0123456789abcde')).toBe(false);
    expect(PUBLIC_ID_SHAPE.test('0123456789abcdef0')).toBe(false);
  });
});

describe('recovery codes', () => {
  const key = Buffer.alloc(32, 5);

  it('are eight distinct codes shaped xxxx-xxxx, from letters and digits that are not mistaken for each other', () => {
    for (let run = 0; run < 50; run += 1) {
      const codes = newRecoveryCodes();
      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
      for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
    }
  });

  it('are kept as keyed hashes: one code gives one hash, and another key gives another', () => {
    const hash = recoveryCodeHash(key, 'k7m2-q9x4');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryCodeHash(key, 'k7m2-q9x4')).toBe(hash);
    expect(recoveryCodeHash(Buffer.alloc(32, 6), 'k7m2-q9x4')).not.toBe(hash);
    expect(recoveryCodeHash(key, 'k7m2-q9x5')).not.toBe(hash);
  });

  it('are hashed under their own label, so that the same text in another table is another hash', () => {
    expect(recoveryCodeHash(key, 'k7m2-q9x4')).toBe(
      createHmac('sha256', key).update('recovery:k7m2-q9x4').digest('hex'),
    );
    expect(recoveryCodeHash(key, 'k7m2-q9x4')).not.toBe(
      createHmac('sha256', key).update('k7m2-q9x4').digest('hex'),
    );
  });

  it('are typed by a person: capitals and spaces around the code do not matter', () => {
    expect(recoveryCodeHash(key, '  K7M2-Q9X4 ')).toBe(recoveryCodeHash(key, 'k7m2-q9x4'));
  });

  it('are not mistaken for anything else: a text of another shape has no hash', () => {
    for (const text of ['', '123456', 'k7m2q9x4', 'k7m2-q9x', 'k7m2-q9x4-1', 'k7m2_q9x4']) {
      expect(recoveryCodeHash(key, text), text).toBeNull();
    }
  });
});

describe('TOTP', () => {
  const secret = newTotpSecret();
  const NOW = Date.UTC(2026, 9, 26, 6, 0, 10);

  it('makes a base32 secret and a link an authenticator app reads', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri(secret, 'owner')).toBe(
      `otpauth://totp/VM%20Gold%20Signal:owner?secret=${secret}&issuer=VM%20Gold%20Signal`,
    );
  });

  it('accepts the code of this step and one step either side, and no other', async () => {
    const { generate } = await import('otplib');
    const at = (offsetS: number) => generate({ secret, epoch: Math.floor(NOW / 1000) + offsetS });
    const step = Math.floor(NOW / 1000 / 30);
    expect(await totpStep(secret, await at(0), NOW)).toBe(step);
    expect(await totpStep(secret, await at(-30), NOW)).toBe(step - 1);
    expect(await totpStep(secret, await at(30), NOW)).toBe(step + 1);
    expect(await totpStep(secret, await at(-90), NOW)).toBeNull();
    expect(await totpStep(secret, await at(90), NOW)).toBeNull();
  });

  it('refuses a wrong code and a text that is not a code, without throwing', async () => {
    expect(await totpStep(secret, '000000', NOW + 3_600_000)).toBeNull();
    expect(await totpStep(secret, 'abcdef', NOW)).toBeNull();
    expect(await totpStep(secret, '', NOW)).toBeNull();
    expect(await totpStep('not base32 !!', '123456', NOW)).toBeNull();
  });

  it('lets a step through once, and never an earlier one afterwards', () => {
    const guard = new TotpReplayGuard();
    expect(guard.accept(100)).toBe(true);
    expect(guard.accept(100)).toBe(false);
    expect(guard.accept(99)).toBe(false);
    expect(guard.accept(101)).toBe(true);
  });
});

describe('clientKey', () => {
  it('is an IPv4 address as it is, and an IPv4 address in IPv6 clothes as the same', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('is the /64 of an IPv6 address, however it is written', () => {
    const expected = '2001:db8:1:2::/64';
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(expected);
    expect(clientKey('2001:db8:1:2::1')).toBe(expected);
    expect(clientKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(expected);
    expect(clientKey('2001:DB8:1:2:ffff::')).toBe(expected);
    expect(clientKey('2001:db8:1:3::1')).not.toBe(expected);
  });

  it('handles the short forms and a zone', () => {
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('::')).toBe('0:0:0:0::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(clientKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  it('puts everything that is no address under one key', () => {
    for (const text of ['', 'unknown', 'not an ip', '999.1.1.1', '1.2.3']) {
      expect(clientKey(text), text).toBe('unknown');
    }
  });
});

describe('decideThrottle', () => {
  const T = 1_000_000;
  const { windowMs } = DEFAULT_THROTTLE;
  const times = (count: number, start: number, step = 1000) =>
    Array.from({ length: count }, (_, i) => start + i * step);

  it('lets a client with fewer failures than the limit in', () => {
    expect(decideThrottle(times(4, T), [], T + 10_000)).toEqual({ allowed: true });
    expect(decideThrottle([], [], T)).toEqual({ allowed: true });
  });

  it('stops a client at the limit until its oldest failure leaves the window', () => {
    const failures = times(5, T);
    expect(decideThrottle(failures, failures, T + 5000)).toEqual({
      allowed: false,
      retryAfterMs: windowMs - 5000,
    });
    // one millisecond before the oldest leaves the window: still stopped
    expect(decideThrottle(failures, failures, T + windowMs - 1)).toMatchObject({ allowed: false });
  });

  it('stops everybody at the total limit, and waits for the later of the two', () => {
    const total = times(40, T, 100);
    expect(decideThrottle([], total, T + 5000)).toEqual({
      allowed: false,
      retryAfterMs: windowMs - 5000,
    });
    const client = times(5, T + 600_000);
    const both = decideThrottle(client, total, T + 600_000);
    expect(both).toEqual({ allowed: false, retryAfterMs: T + 600_000 + windowMs - (T + 600_000) });
  });

  it('never tells to wait less than a second', () => {
    const failures = times(5, T);
    expect(decideThrottle(failures, [], T + windowMs - 10)).toEqual({
      allowed: false,
      retryAfterMs: 1000,
    });
  });

  it('follows the policy it is given', () => {
    const policy = { windowMs: 60_000, maxFailuresPerClient: 2, maxFailuresTotal: 3, knownMs: 1 };
    expect(decideThrottle([T, T + 1], [T, T + 1], T + 2, policy)).toMatchObject({ allowed: false });
    expect(decideThrottle([T], [T, T + 1], T + 2, policy)).toEqual({ allowed: true });
    expect(decideThrottle([T], [T, T + 1, T + 2], T + 3, policy)).toMatchObject({ allowed: false });
  });

  it('does not stop a client that has got in before because of what others did (only its own failures count)', () => {
    const total = times(40, T, 100);
    expect(decideThrottle([], total, T + 5000, DEFAULT_THROTTLE, false)).toMatchObject({
      allowed: false,
    });
    expect(decideThrottle([], total, T + 5000, DEFAULT_THROTTLE, true)).toEqual({ allowed: true });
    // its own limit still holds
    const own = times(5, T);
    expect(decideThrottle(own, total, T + 5000, DEFAULT_THROTTLE, true)).toMatchObject({
      allowed: false,
      retryAfterMs: windowMs - 5000,
    });
  });

  it('is the default of a client that is not said to be known', () => {
    expect(decideThrottle([], times(40, T, 100), T + 5000)).toMatchObject({ allowed: false });
  });
});

describe('sessionExpiry', () => {
  const { idleMs, maxMs } = DEFAULT_SESSION_POLICY;

  it('is the idle time after now, but never later than the maximum after the login', () => {
    const created = 0;
    expect(sessionExpiry(created, 0, DEFAULT_SESSION_POLICY)).toBe(idleMs);
    expect(sessionExpiry(created, 3 * 86_400_000, DEFAULT_SESSION_POLICY)).toBe(
      3 * 86_400_000 + idleMs,
    );
    expect(sessionExpiry(created, maxMs - 1000, DEFAULT_SESSION_POLICY)).toBe(maxMs);
    expect(sessionExpiry(created, maxMs + 5 * 86_400_000, DEFAULT_SESSION_POLICY)).toBe(maxMs);
  });
});
