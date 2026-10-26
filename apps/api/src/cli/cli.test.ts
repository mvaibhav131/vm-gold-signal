import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SecretHasher } from '../auth/hasher';
import { Limiter } from '../auth/limiter';
import { MemoryAuthStore } from '../testing/memoryAuthStore';
import { OWNER, TEST_ARGON, makeHarness } from '../testing/harness';
import { CLI_USAGE, runCli, type CliDeps } from './commands';
import { EMPTY_TYPING, firstLine, typeInto } from './terminal';

const NOW = Date.UTC(2026, 9, 26, 6, 0, 0);

function setup(secrets: string[], overrides: Partial<CliDeps> = {}) {
  const store = new MemoryAuthStore();
  const lines: string[] = [];
  const prompts: string[] = [];
  const queue = [...secrets];
  const deps: CliDeps = {
    store,
    hasher: new SecretHasher(TEST_ARGON, new Limiter(1, 0)),
    now: () => NOW,
    print: (line) => lines.push(line),
    readSecret: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(queue.shift() ?? '');
    },
    interactive: true,
    ...overrides,
  };
  return { store, lines, prompts, deps, run: (...args: string[]) => runCli(args, deps) };
}

const GOOD = 'a long enough passphrase';

describe('owner:create', () => {
  it('makes the owner with a password asked for twice, and prints no password', async () => {
    const t = setup([GOOD, GOOD]);
    expect(await t.run('owner:create', 'vaibhav')).toBe(0);
    expect(t.prompts).toEqual(['New password: ', 'Again: ']);
    const owner = await t.store.owner();
    expect(owner?.username).toBe('vaibhav');
    expect(owner?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await t.deps.hasher.verify(owner?.passwordHash ?? '', GOOD)).toBe(true);
    expect(t.lines.join('\n')).not.toContain(GOOD);
    expect(JSON.stringify(t.store.auditLog)).not.toContain(GOOD);
    expect(t.store.auditLog.map((event) => [event.type, event.detail])).toEqual([
      ['OWNER_CREATED', { via: 'cli' }],
    ]);
  });

  it('asks once from a pipe', async () => {
    const t = setup([GOOD], { interactive: false });
    expect(await t.run('owner:create', 'vaibhav')).toBe(0);
    expect(t.prompts).toEqual(['New password: ']);
  });

  it('refuses a second owner and says what to use instead', async () => {
    const t = setup([GOOD, GOOD]);
    await t.run('owner:create', 'vaibhav');
    const again = setup([GOOD, GOOD], { store: t.store });
    expect(await again.run('owner:create', 'somebody')).toBe(1);
    expect(again.lines.join('\n')).toContain('owner:password');
    expect(again.prompts).toEqual([]); // it does not ask for a password it would not use
    expect((await t.store.owner())?.username).toBe('vaibhav');
  });

  it('takes a password of exactly 12 characters and refuses 11, takes 1024 and refuses 1025', async () => {
    for (const [length, code] of [
      [11, 2],
      [12, 0],
      [1024, 0],
      [1025, 2],
    ] as const) {
      const secret = 'x'.repeat(length);
      const t = setup([secret, secret]);
      expect(await t.run('owner:create', 'vaibhav'), String(length)).toBe(code);
    }
  });

  it('refuses a short password, a long one, and two that differ, and makes nobody', async () => {
    for (const secrets of [
      ['short', 'short'],
      ['x'.repeat(1025), 'x'.repeat(1025)],
      [GOOD, `${GOOD}!`],
    ]) {
      const t = setup(secrets);
      expect(await t.run('owner:create', 'vaibhav')).toBe(2);
      expect(await t.store.owner()).toBeNull();
    }
  });

  it('refuses a user name that is missing, odd or too long, before it asks for anything', async () => {
    for (const args of [[], ['has space'], ['a'.repeat(101)], ['a', 'b'], ['x;rm']]) {
      const t = setup([GOOD, GOOD]);
      expect(await t.run('owner:create', ...args), args.join(' ')).toBe(2);
      expect(t.prompts).toEqual([]);
    }
  });
});

describe('owner:password', () => {
  it('sets a new password, ends every session and writes it to the audit', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const lines: string[] = [];
    const deps: CliDeps = {
      store: h.store,
      hasher: h.hasher,
      now: () => h.clock.now,
      print: (line) => lines.push(line),
      readSecret: () => Promise.resolve('a brand new passphrase'),
      interactive: false,
    };
    expect(await runCli(['owner:password'], deps)).toBe(0);
    expect(lines).toEqual(['The password was changed. 1 session(s) ended.']);
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(401);
    expect((await h.send({ url: '/api/v1/auth/login', body: OWNER })).status).toBe(401);
    expect(
      (
        await h.send({
          url: '/api/v1/auth/login',
          body: { ...OWNER, password: 'a brand new passphrase' },
        })
      ).status,
    ).toBe(204);
    expect(
      h.store.auditLog.find((event) => event.type === 'PASSWORD_CHANGED' && event.ipHash === null),
    ).toMatchObject({
      detail: { via: 'cli', sessionsEnded: 1 },
    });
  });

  it('needs an owner', async () => {
    const t = setup([GOOD, GOOD]);
    expect(await t.run('owner:password')).toBe(1);
  });
});

describe('owner:totp-off', () => {
  it('turns the second step off for somebody who has lost the phone and the codes, and ends the sessions', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie });
    const owner = await h.store.owner();
    if (owner?.totpSecretEnc === null || owner === null) throw new Error('no secret was set up');
    await h.store.enableTotp(['a'.repeat(64)], owner.totpSecretEnc);

    const lines: string[] = [];
    const deps: CliDeps = {
      store: h.store,
      hasher: h.hasher,
      now: () => h.clock.now,
      print: (line) => lines.push(line),
      readSecret: () => Promise.resolve(''),
      interactive: false,
    };
    expect(await runCli(['owner:totp-off'], deps)).toBe(0);
    expect(await h.store.owner()).toMatchObject({
      totpEnabled: false,
      totpSecretEnc: null,
      recoveryCodeHashes: [],
    });
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(401);
    await h.login(); // no code needed
  });

  it('needs an owner', async () => {
    expect(await setup([]).run('owner:totp-off')).toBe(1);
  });
});

describe('owner:status and sessions:revoke-all', () => {
  it('shows the facts and nothing secret', async () => {
    const h = await makeHarness();
    await h.login();
    await h.login({}, '198.51.100.9');
    const lines: string[] = [];
    const deps: CliDeps = {
      store: h.store,
      hasher: h.hasher,
      now: () => h.clock.now,
      print: (line) => lines.push(line),
      readSecret: () => Promise.resolve(''),
      interactive: false,
    };
    expect(await runCli(['owner:status'], deps)).toBe(0);
    expect(lines).toEqual([
      'owner: owner',
      'second step: off',
      'recovery codes left: 0',
      'sessions open: 2',
    ]);

    lines.length = 0;
    expect(await runCli(['sessions:revoke-all'], deps)).toBe(0);
    expect(lines).toEqual(['2 session(s) ended.']);
    expect(await h.store.sessions(h.clock.now)).toEqual([]);
  });

  it('says there is no owner yet', async () => {
    const t = setup([]);
    expect(await t.run('owner:status')).toBe(1);
    expect(t.lines[0]).toContain('owner:create');
  });
});

describe('throttle:reset', () => {
  it('lifts a lockout: the failed tries are forgotten, the clients that got in stay known, and it is audited', async () => {
    const h = await makeHarness();
    await h.login({}, '203.0.113.99'); // the owner at home
    const wrong = { ...OWNER, password: 'wrong wrong wrong' };
    for (let i = 0; i < 45; i += 1) {
      await h.send({ url: '/api/v1/auth/login', body: wrong, ip: `198.51.100.${String(i + 10)}` });
    }
    // the owner's new phone is a client that has never got in: locked out by the swarm
    const phone = '192.0.2.200';
    expect((await h.send({ url: '/api/v1/auth/login', body: OWNER, ip: phone })).status).toBe(429);

    const lines: string[] = [];
    const deps: CliDeps = {
      store: h.store,
      hasher: h.hasher,
      now: () => h.clock.now,
      print: (line) => lines.push(line),
      readSecret: () => Promise.resolve(''),
      interactive: false,
    };
    expect(await runCli(['throttle:reset'], deps)).toBe(0);
    // 45 were tried, 40 were let in and written down: the rest were refused and wrote nothing
    expect(lines).toEqual(['40 failed try(s) forgotten. Log in now.']);
    expect(h.store.auditLog.find((event) => event.type === 'THROTTLE_RESET')).toMatchObject({
      success: true,
      ipHash: null,
      detail: { via: 'cli', cleared: 40 },
    });

    // the first login from the new place works, and from then on that place is known to the throttle
    expect((await h.send({ url: '/api/v1/auth/login', body: OWNER, ip: phone })).status).toBe(204);
    for (let i = 0; i < 45; i += 1) {
      await h.send({ url: '/api/v1/auth/login', body: wrong, ip: `198.51.100.${String(i + 10)}` });
    }
    expect((await h.send({ url: '/api/v1/auth/login', body: OWNER, ip: phone })).status).toBe(204);
    expect(
      (await h.send({ url: '/api/v1/auth/login', body: OWNER, ip: '192.0.2.201' })).status,
    ).toBe(429);
  });

  it('takes no argument and nothing secret, and says so when there is nothing to forget', async () => {
    const t = setup([]);
    expect(await t.run('throttle:reset')).toBe(0);
    expect(t.lines).toEqual(['0 failed try(s) forgotten. Log in now.']);
    expect(t.prompts).toEqual([]);
  });
});

describe('usage', () => {
  it('is printed, with exit code 2, for no command or an unknown one', async () => {
    for (const args of [[], ['owner:delete'], ['--help']]) {
      const t = setup([]);
      expect(await t.run(...args)).toBe(2);
      expect(t.lines).toEqual([CLI_USAGE]);
    }
  });

  it('has no command that makes an owner without a password, deletes the owner or shows a hash', () => {
    expect(CLI_USAGE).not.toMatch(/delete|hash|show-secret|--password/i);
  });
});

describe('typing a password at a terminal', () => {
  const type = (...chunks: string[]) => chunks.reduce(typeInto, EMPTY_TYPING);

  it('collects the characters until Enter, and echoes nothing (it only returns the value)', () => {
    expect(type('abc', 'def\r')).toEqual({ value: 'abcdef', done: true, cancelled: false });
    expect(type('abc\n')).toMatchObject({ value: 'abc', done: true });
    expect(type('p', 'a', 's', 's')).toMatchObject({ value: 'pass', done: false });
  });

  it('takes a paste in one chunk, spaces and symbols included', () => {
    expect(type('correct horse "battery" staple!\r').value).toBe('correct horse "battery" staple!');
  });

  it('lets backspace take a character away, also a character outside the basic range', () => {
    expect(type('abcd\u007f\u007f').value).toBe('ab');
    expect(type('ab\bc').value).toBe('ac');
    expect(type('a€\u007f').value).toBe('a');
    expect(type('\u007f\u007f').value).toBe('');
  });

  it('is cancelled by Ctrl-C and Ctrl-D', () => {
    expect(type('abc\u0003')).toMatchObject({ cancelled: true });
    expect(type('abc\u0004')).toMatchObject({ cancelled: true });
  });

  it('drops control characters and the escape sequence of an arrow key', () => {
    expect(type('ab\u001b[Ac').value).toBe('ab'); // the sequence swallows the rest of its chunk
    expect(type('ab\u0001\u0002c').value).toBe('abc');
    expect(type('ab', '\u001b[A', 'cd').value).toBe('abcd');
  });

  it('reads the first line of a pipe, and nothing after it', async () => {
    expect(await firstLine(Readable.from([Buffer.from('first line\nsecond line\n')]))).toBe(
      'first line',
    );
    expect(await firstLine(Readable.from([Buffer.from('with return\r\n')]))).toBe('with return');
    expect(await firstLine(Readable.from([Buffer.from('no newline')]))).toBe('no newline');
    expect(await firstLine(Readable.from([Buffer.from('spl'), Buffer.from('it\nrest')]))).toBe(
      'split',
    );
    expect(await firstLine(Readable.from([]))).toBe('');
  });
});
