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
    expect(await runOps('env:check', ['api'], WORKER_ENV, fake)).toBe(2);
    expect(out[0]).toContain('unknown kind api');
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
