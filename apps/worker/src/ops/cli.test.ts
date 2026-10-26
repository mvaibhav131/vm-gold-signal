import { describe, expect, it } from 'vitest';

import { COUNTED_TABLES } from './manifest';
import { OPS_COMMANDS, runOps, type OpsIo } from './cli';

function io(files: Record<string, string> = {}, stdin = ''): { io: OpsIo; out: string[] } {
  const out: string[] = [];
  return {
    out,
    io: {
      print: (line) => out.push(line),
      readStdin: () => Promise.resolve(stdin),
      readFile: (path) => {
        const text = files[path];
        return text === undefined
          ? Promise.reject(new Error(`no file ${path}`))
          : Promise.resolve(text);
      },
      now: () => 0,
    },
  };
}

const WORKER_ENV = {
  PUBLIC_HOST: 'vmgs-owner.duckdns.org',
  DATABASE_URL_WORKER: 'postgres://vmgs_worker:secret-pw-value@db:5432/vmgs',
  FEED_PROVIDER: 'biquote',
};

const countsJson = (value: number, extra: Record<string, number> = {}) =>
  JSON.stringify({
    ...Object.fromEntries(COUNTED_TABLES.map((table) => [table, value])),
    ...extra,
  });

describe('runOps', () => {
  it('knows its commands and leaves every other command alone', async () => {
    const { io: fake } = io();
    expect(await runOps('telegram:link', [], {}, fake)).toBeNull();
    expect(await runOps('', [], {}, fake)).toBeNull();
    expect(OPS_COMMANDS).toContain('backup:plan');
  });
});

describe('env:check', () => {
  it('checks the worker environment by default and says OK', async () => {
    const { io: fake, out } = io();
    expect(await runOps('env:check', [], WORKER_ENV, fake)).toBe(0);
    expect(out).toEqual(['OK worker']);
  });

  it('names the variable and the rule of a problem, never the value', async () => {
    const { io: fake, out } = io();
    const env = {
      ...WORKER_ENV,
      DATABASE_URL_WORKER: 'postgres://vmgs_api:secret-pw-value@db:5432/vmgs',
    };
    expect(await runOps('env:check', ['worker'], env, fake)).toBe(1);
    expect(out).toEqual([
      'PROBLEM worker',
      '  DATABASE_URL_WORKER: must connect as database role vmgs_worker',
    ]);
    expect(out.join('\n')).not.toContain('secret-pw-value');
  });

  it('checks several kinds and fails when any of them fails', async () => {
    const { io: fake, out } = io();
    expect(await runOps('env:check', ['worker', 'admin'], WORKER_ENV, fake)).toBe(1);
    expect(out[0]).toBe('OK worker');
    expect(out[1]).toBe('PROBLEM admin');
    expect(out.join('\n')).toContain('DATABASE_URL_ADMIN');
    expect(out.join('\n')).toContain('DB_PASSWORD_WORKER');
  });

  it('refuses a kind it does not know', async () => {
    const { io: fake, out } = io();
    expect(await runOps('env:check', ['nonsense'], WORKER_ENV, fake)).toBe(2);
    expect(out[0]).toContain('unknown kind nonsense');
  });

  describe('for the api', () => {
    const KEY = 'ab'.repeat(32);
    const API_ENV = {
      NODE_ENV: 'production',
      PUBLIC_HOST: 'vmgs-owner.duckdns.org',
      API_PORT: '3000',
      API_TRUSTED_PROXY_HOPS: '1',
      DATABASE_URL_API: `postgres://vmgs_api:${'x'.repeat(12)}@db:5432/vmgs`,
      APP_ENCRYPTION_KEY: KEY,
    };

    it('says OK for what compose gives the api service', async () => {
      const { io: fake, out } = io();
      expect(await runOps('env:check', ['api'], API_ENV, fake)).toBe(0);
      expect(out).toEqual(['OK api']);
    });

    it('names a missing key (an empty value counts as not set)', async () => {
      const { io: fake, out } = io();
      const env = { ...API_ENV, APP_ENCRYPTION_KEY: '' };
      expect(await runOps('env:check', ['api'], env, fake)).toBe(1);
      expect(out[0]).toBe('PROBLEM api');
      expect(out.join('\n')).toContain('APP_ENCRYPTION_KEY');
    });

    it('refuses a key that is too short, and a login as the wrong role, without printing them', async () => {
      const short = io();
      expect(
        await runOps('env:check', ['api'], { ...API_ENV, APP_ENCRYPTION_KEY: 'abc123' }, short.io),
      ).toBe(1);
      expect(short.out.join('\n')).toContain('32 random bytes');
      expect(short.out.join('\n')).not.toContain('abc123');

      const role = io();
      const env = {
        ...API_ENV,
        DATABASE_URL_API: `postgres://vmgs_worker:${'y'.repeat(12)}@db/vmgs`,
      };
      expect(await runOps('env:check', ['api'], env, role.io)).toBe(1);
      expect(role.out.join('\n')).toContain('must connect as database role vmgs_api');
      expect(role.out.join('\n')).not.toContain('y'.repeat(12));
    });

    it('does not accept a site that is not https in production', async () => {
      const { io: fake, out } = io();
      const env = { ...API_ENV, SITE_ORIGIN: 'http://localhost:5173' };
      expect(await runOps('env:check', ['api'], env, fake)).toBe(1);
      expect(out.join('\n')).toContain('the site origin must be https in production');
    });

    it('is checked together with the others', async () => {
      const { io: fake, out } = io();
      expect(
        await runOps('env:check', ['worker', 'api'], { ...WORKER_ENV, ...API_ENV }, fake),
      ).toBe(0);
      expect(out).toEqual(['OK worker', 'OK api']);
    });
  });
});

describe('vapid:generate', () => {
  const pair = async () => {
    const { io: fake, out } = io();
    expect(await runOps('vapid:generate', [], {}, fake)).toBe(0);
    return out;
  };

  it('prints a new pair of keys and the subject to fill in, three lines for the .env', async () => {
    const out = await pair();
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}$/);
    expect(out[1]).toMatch(/^VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{43}$/);
    expect(out[2]).toBe('VAPID_SUBJECT=mailto:you@example.com');
  });

  it('makes lines that the environment check of the worker accepts, as the three belong together', async () => {
    const out = await pair();
    const vapid = Object.fromEntries(
      out.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const { io: fake, out: checked } = io();
    expect(await runOps('env:check', ['worker'], { ...WORKER_ENV, ...vapid }, fake)).toBe(0);
    expect(checked).toEqual(['OK worker']);
  });

  it('makes another pair every time, and is one of the commands that the CLI knows', async () => {
    expect((await pair())[0]).not.toBe((await pair())[0]);
    expect(OPS_COMMANDS).toContain('vapid:generate');
  });
});

describe('backup:plan', () => {
  it('says what to keep, what to remove and what to leave alone', async () => {
    const stdin = [
      'vmgs-20261026T020000Z.dump.age',
      'vmgs-20261026T010000Z.dump.age',
      '',
      '  notes.txt  ',
    ].join('\n');
    const { io: fake, out } = io({}, stdin);
    expect(await runOps('backup:plan', [], {}, fake)).toBe(0);
    expect(out).toEqual([
      'KEEP vmgs-20261026T020000Z.dump.age',
      'REMOVE vmgs-20261026T010000Z.dump.age',
      'IGNORE notes.txt',
    ]);
  });

  it('prints nothing for an empty list', async () => {
    const { io: fake, out } = io({}, '');
    expect(await runOps('backup:plan', [], {}, fake)).toBe(0);
    expect(out).toEqual([]);
  });
});

describe('backup:check', () => {
  it('passes a good copy and prints a line per table', async () => {
    const { io: fake, out } = io({ m: countsJson(5), r: countsJson(6), l: countsJson(7) });
    expect(await runOps('backup:check', ['m', 'r', 'l'], {}, fake)).toBe(0);
    expect(out.at(-1)).toBe('OK the restored copy matches the backup');
    expect(out).toHaveLength(COUNTED_TABLES.length + 1);
  });

  it('fails a copy that lost rows', async () => {
    const { io: fake, out } = io({
      m: countsJson(5),
      r: countsJson(5, { signals: 4 }),
      l: countsJson(7),
    });
    expect(await runOps('backup:check', ['m', 'r', 'l'], {}, fake)).toBe(1);
    expect(out).toContain(
      'PROBLEM signals: the restored copy has 4 rows, the backup was made with 5',
    );
    expect(out.at(-1)).toBe('FAILED the restored copy is not a good copy');
  });

  it('fails a file that is not a map of counts, naming the file', async () => {
    const good = countsJson(1);
    await expect(
      runOps('backup:check', ['m', 'r', 'l'], {}, io({ m: good, r: 'oops', l: good }).io),
    ).rejects.toThrow('r is not JSON');
    await expect(
      runOps('backup:check', ['m', 'r', 'l'], {}, io({ m: good, r: '[1]', l: good }).io),
    ).rejects.toThrow('r is not a map of table counts');
    await expect(
      runOps('backup:check', ['m', 'r', 'l'], {}, io({ m: good, r: good }).io),
    ).rejects.toThrow('no file l');
  });

  it('needs its three files', async () => {
    const { io: fake, out } = io();
    expect(await runOps('backup:check', ['m'], {}, fake)).toBe(2);
    expect(out[0]).toContain('usage');
  });
});

describe('worker:alive and backup:counts', () => {
  it('refuse a maximum age that is not a positive number, before they touch a database', async () => {
    const { io: fake, out } = io();
    expect(await runOps('worker:alive', ['soon'], WORKER_ENV, fake)).toBe(2);
    expect(await runOps('worker:alive', ['0'], WORKER_ENV, fake)).toBe(2);
    expect(out).toHaveLength(2);
  });

  it('backup:counts needs the variable that holds the URL', async () => {
    const { io: fake, out } = io();
    expect(await runOps('backup:counts', [], {}, fake)).toBe(2);
    expect(await runOps('backup:counts', ['DRILL_URL'], { DRILL_URL: '' }, fake)).toBe(2);
    expect(out).toEqual(['DATABASE_URL_BACKUP is not set', 'DRILL_URL is not set']);
  });
});
