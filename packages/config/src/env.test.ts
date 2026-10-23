import { describe, expect, it } from 'vitest';

import { EnvError, apiEnvSchema, backupEnvSchema, parseEnv, workerEnvSchema } from './env';

const KEY_BASE64 = 'qT3r0wq1L1m0b9m5dD2hQ4Zb8mQm2kz0Yc2m0m2k0aA=';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-secret';
const VAPID_PUBLIC = 'B'.repeat(87);
const VAPID_PRIVATE = 'p'.repeat(43);

const api = {
  PUBLIC_HOST: 'vmgs-owner.duckdns.org',
  DATABASE_URL_API: 'postgres://vmgs_api:s3cret@db:5432/vmgs',
  APP_ENCRYPTION_KEY: KEY_BASE64,
};

const worker = {
  PUBLIC_HOST: 'vmgs-owner.duckdns.org',
  DATABASE_URL_WORKER: 'postgres://vmgs_worker:s3cret@db:5432/vmgs',
  FEED_PROVIDER: 'biquote',
};

function problems(schema: Parameters<typeof parseEnv>[0], env: Record<string, string | undefined>) {
  try {
    parseEnv(schema, env);
    return [];
  } catch (error) {
    if (error instanceof EnvError) return [...error.problems];
    throw error;
  }
}

describe('apiEnvSchema', () => {
  it('parses a minimal environment and applies defaults', () => {
    expect(parseEnv(apiEnvSchema, api)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_PORT: 3000,
      PUBLIC_HOST: 'vmgs-owner.duckdns.org',
    });
  });

  it('coerces the port and ignores unrelated variables', () => {
    const env = parseEnv(apiEnvSchema, {
      ...api,
      API_PORT: '8080',
      PATH: '/usr/bin',
      HOME: '/root',
    });
    expect(env.API_PORT).toBe(8080);
    expect('PATH' in env).toBe(false);
  });

  it('accepts a hex encryption key too', () => {
    expect(problems(apiEnvSchema, { ...api, APP_ENCRYPTION_KEY: 'a'.repeat(64) })).toEqual([]);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(problems(apiEnvSchema, { ...api, APP_ENCRYPTION_KEY: 'short' })).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, APP_ENCRYPTION_KEY: 'a'.repeat(63) })).toHaveLength(1);
  });

  it('reports every missing variable by name', () => {
    const found = problems(apiEnvSchema, {});
    expect(found.some((p) => p.startsWith('PUBLIC_HOST'))).toBe(true);
    expect(found.some((p) => p.startsWith('DATABASE_URL_API'))).toBe(true);
    expect(found.some((p) => p.startsWith('APP_ENCRYPTION_KEY'))).toBe(true);
  });

  it('treats an empty value like an unset one', () => {
    expect(problems(apiEnvSchema, { ...api, VAPID_PUBLIC_KEY: '' })).toEqual([]);
    expect(problems(apiEnvSchema, { ...api, PUBLIC_HOST: '' })).toHaveLength(1);
  });

  it('rejects a host with a scheme or path', () => {
    expect(
      problems(apiEnvSchema, { ...api, PUBLIC_HOST: 'https://vmgs.duckdns.org' }),
    ).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, PUBLIC_HOST: 'vmgs.duckdns.org/app' })).toHaveLength(1);
  });

  it('only lets the api connect as vmgs_api', () => {
    const found = problems(apiEnvSchema, {
      ...api,
      DATABASE_URL_API: 'postgres://vmgs_worker:s3cret@db:5432/vmgs',
    });
    expect(found).toEqual(['DATABASE_URL_API: must connect as database role vmgs_api']);
  });

  it('rejects non-postgres URLs', () => {
    expect(
      problems(apiEnvSchema, { ...api, DATABASE_URL_API: 'mysql://vmgs_api@db/vmgs' }),
    ).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, DATABASE_URL_API: 'not a url' })).toHaveLength(1);
  });

  it('refuses to run with TLS verification disabled', () => {
    expect(problems(apiEnvSchema, { ...api, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toEqual([
      'NODE_TLS_REJECT_UNAUTHORIZED: TLS verification must not be disabled',
    ]);
    expect(problems(apiEnvSchema, { ...api, NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toEqual([]);
  });

  it('rejects an unknown NODE_ENV or log level', () => {
    expect(problems(apiEnvSchema, { ...api, NODE_ENV: 'staging' })).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, LOG_LEVEL: 'verbose' })).toHaveLength(1);
  });

  it('rejects a port out of range', () => {
    expect(problems(apiEnvSchema, { ...api, API_PORT: '0' })).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, API_PORT: '70000' })).toHaveLength(1);
    expect(problems(apiEnvSchema, { ...api, API_PORT: 'http' })).toHaveLength(1);
  });
});

describe('workerEnvSchema', () => {
  it('parses a minimal environment', () => {
    const env = parseEnv(workerEnvSchema, worker);
    expect(env.FEED_PROVIDER).toBe('biquote');
    expect(env.FEED_SYMBOLS).toEqual(['XAUUSD', 'DXY', 'XAGUSD']);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('has no default feed provider', () => {
    const { FEED_PROVIDER: _provider, ...without } = worker;
    expect(problems(workerEnvSchema, without)).toEqual([expect.stringMatching(/^FEED_PROVIDER:/)]);
    expect(problems(workerEnvSchema, { ...worker, FEED_PROVIDER: 'demo' })).toHaveLength(1);
  });

  it('only lets the worker connect as vmgs_worker', () => {
    expect(
      problems(workerEnvSchema, {
        ...worker,
        DATABASE_URL_WORKER: 'postgres://vmgs_api:x@db/vmgs',
      }),
    ).toEqual(['DATABASE_URL_WORKER: must connect as database role vmgs_worker']);
  });

  it('parses and validates the symbol list', () => {
    expect(
      parseEnv(workerEnvSchema, { ...worker, FEED_SYMBOLS: 'XAUUSD, DXY' }).FEED_SYMBOLS,
    ).toEqual(['XAUUSD', 'DXY']);
    expect(problems(workerEnvSchema, { ...worker, FEED_SYMBOLS: 'DXY,XAGUSD' })).toHaveLength(1);
    expect(problems(workerEnvSchema, { ...worker, FEED_SYMBOLS: 'XAUUSD,XAUUSD' })).toHaveLength(1);
    expect(problems(workerEnvSchema, { ...worker, FEED_SYMBOLS: 'XAUUSD,eur usd' })).toHaveLength(
      1,
    );
  });

  it('validates the Telegram bot token format', () => {
    expect(problems(workerEnvSchema, { ...worker, TELEGRAM_BOT_TOKEN: TOKEN })).toEqual([]);
    expect(problems(workerEnvSchema, { ...worker, TELEGRAM_BOT_TOKEN: 'abc' })).toHaveLength(1);
  });

  it('needs all VAPID values or none', () => {
    const all = {
      VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      VAPID_SUBJECT: 'mailto:owner@example.com',
    };
    expect(problems(workerEnvSchema, { ...worker, ...all })).toEqual([]);
    expect(problems(workerEnvSchema, { ...worker, VAPID_PUBLIC_KEY: VAPID_PUBLIC })).toHaveLength(
      1,
    );
    expect(problems(workerEnvSchema, { ...worker, ...all, VAPID_SUBJECT: 'owner' })).toHaveLength(
      1,
    );
  });

  it('accepts an https heartbeat URL only', () => {
    expect(
      problems(workerEnvSchema, { ...worker, HEALTHCHECKS_PING_URL: 'https://hc-ping.com/abc' }),
    ).toEqual([]);
    expect(
      problems(workerEnvSchema, { ...worker, HEALTHCHECKS_PING_URL: 'http://hc-ping.com/abc' }),
    ).toHaveLength(1);
  });
});

describe('secrets never appear in error messages', () => {
  it('does not echo invalid secret values', () => {
    const secrets = ['hunter2-hunter2', 'tg-secret-token', 'bad-key-value'];
    const found = problems(workerEnvSchema, {
      ...worker,
      DATABASE_URL_WORKER: `postgres://vmgs_api:${secrets[0] ?? ''}@db/vmgs`,
      TELEGRAM_BOT_TOKEN: secrets[1],
      VAPID_PRIVATE_KEY: secrets[2],
    });
    expect(found.length).toBeGreaterThan(0);
    const text = found.join('\n');
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it('does not echo an invalid encryption key', () => {
    const text = problems(apiEnvSchema, {
      ...api,
      APP_ENCRYPTION_KEY: 'super-secret-wrong-key',
    }).join('\n');
    expect(text).not.toContain('super-secret-wrong-key');
  });
});

describe('backupEnvSchema', () => {
  const backup = {
    BACKUP_AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
    BACKUP_RCLONE_REMOTE: 'oci:vmgs-backups/db',
  };

  it('accepts an age public key and an rclone remote', () => {
    expect(problems(backupEnvSchema, backup)).toEqual([]);
  });

  it('rejects an age private key and a remote without a name', () => {
    expect(
      problems(backupEnvSchema, {
        ...backup,
        BACKUP_AGE_RECIPIENT: `AGE-SECRET-KEY-1${'Q'.repeat(58)}`,
      }),
    ).toHaveLength(1);
    expect(
      problems(backupEnvSchema, { ...backup, BACKUP_RCLONE_REMOTE: 'bucket/path' }),
    ).toHaveLength(1);
  });
});
