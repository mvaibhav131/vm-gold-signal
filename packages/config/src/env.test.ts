import { describe, expect, it } from 'vitest';

import {
  EnvError,
  adminEnvSchema,
  apiCliEnvSchema,
  apiEnvSchema,
  backupEnvSchema,
  parseEnv,
  researchEnvSchema,
  siteOriginOf,
  workerEnvSchema,
} from './env';

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

  it('takes the CA of a TLS database as PEM text, with real or written \\n line breaks, and nothing else', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(problems(apiEnvSchema, { ...api, DATABASE_CA_PEM: pem })).toEqual([]);
    expect(
      problems(apiEnvSchema, { ...api, DATABASE_CA_PEM: pem.replaceAll('\n', '\\n') }),
    ).toEqual([]);
    expect(problems(apiEnvSchema, { ...api, DATABASE_CA_PEM: '/etc/ssl/ca.pem' })).toEqual([
      'DATABASE_CA_PEM: must be the PEM text of a certificate (-----BEGIN CERTIFICATE-----)',
    ]);
    expect(
      problems(workerEnvSchema, { ...worker, DATABASE_CA_PEM: '-----BEGIN PRIVATE KEY-----' }),
    ).toHaveLength(1);
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

  it('trusts no proxy unless told how many stand in front (at most 3)', () => {
    expect(parseEnv(apiEnvSchema, api).API_TRUSTED_PROXY_HOPS).toBe(0);
    expect(
      parseEnv(apiEnvSchema, { ...api, API_TRUSTED_PROXY_HOPS: '1' }).API_TRUSTED_PROXY_HOPS,
    ).toBe(1);
    for (const hops of ['-1', '4', '1.5', 'one']) {
      expect(problems(apiEnvSchema, { ...api, API_TRUSTED_PROXY_HOPS: hops }), hops).toHaveLength(
        1,
      );
    }
  });

  it('has the site origin https://PUBLIC_HOST unless SITE_ORIGIN says otherwise', () => {
    expect(siteOriginOf(parseEnv(apiEnvSchema, api))).toBe('https://vmgs-owner.duckdns.org');
    const dev = parseEnv(apiEnvSchema, { ...api, SITE_ORIGIN: 'http://localhost:5173' });
    expect(siteOriginOf(dev)).toBe('http://localhost:5173');
  });

  it('refuses a site origin that is not an origin, and http in production', () => {
    for (const origin of [
      'vmgs.duckdns.org',
      'https://vmgs.duckdns.org/',
      'https://vmgs.duckdns.org/app',
      'ftp:/x',
    ]) {
      expect(problems(apiEnvSchema, { ...api, SITE_ORIGIN: origin }), origin).toHaveLength(1);
    }
    expect(
      problems(apiEnvSchema, {
        ...api,
        NODE_ENV: 'production',
        SITE_ORIGIN: 'http://localhost:5173',
      }),
    ).toEqual(['SITE_ORIGIN: the site origin must be https in production']);
    expect(
      problems(apiEnvSchema, {
        ...api,
        NODE_ENV: 'production',
        SITE_ORIGIN: 'https://vmgs.duckdns.org',
      }),
    ).toEqual([]);
  });
});

describe('apiCliEnvSchema', () => {
  it('needs only the database of the api role', () => {
    const env = parseEnv(apiCliEnvSchema, { DATABASE_URL_API: api.DATABASE_URL_API });
    expect(env.DATABASE_URL_API).toBe(api.DATABASE_URL_API);
    expect('APP_ENCRYPTION_KEY' in env).toBe(false);
    expect(problems(apiCliEnvSchema, {})).toEqual([
      expect.stringMatching(/^DATABASE_URL_API:/) as string,
    ]);
    expect(problems(apiCliEnvSchema, { DATABASE_URL_API: worker.DATABASE_URL_WORKER })).toEqual([
      'DATABASE_URL_API: must connect as database role vmgs_api',
    ]);
  });
});

describe('researchEnvSchema', () => {
  it('needs only the database of the worker role', () => {
    const env = parseEnv(researchEnvSchema, { DATABASE_URL_WORKER: worker.DATABASE_URL_WORKER });
    expect(env.DATABASE_URL_WORKER).toBe(worker.DATABASE_URL_WORKER);
    expect(env.NODE_ENV).toBe('development');
    expect('PUBLIC_HOST' in env).toBe(false);
  });

  it('refuses a missing URL, another role, and a disabled TLS check', () => {
    expect(problems(researchEnvSchema, {})).toEqual([
      expect.stringMatching(/^DATABASE_URL_WORKER:/),
    ]);
    expect(problems(researchEnvSchema, { DATABASE_URL_WORKER: api.DATABASE_URL_API })).toEqual([
      'DATABASE_URL_WORKER: must connect as database role vmgs_worker',
    ]);
    expect(
      problems(researchEnvSchema, {
        DATABASE_URL_WORKER: worker.DATABASE_URL_WORKER,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      }),
    ).toHaveLength(1);
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

  it('has no pool size unless DATABASE_POOL_MAX is set, and takes 1 to 20', () => {
    expect(parseEnv(workerEnvSchema, worker).DATABASE_POOL_MAX).toBeUndefined();
    expect(parseEnv(workerEnvSchema, { ...worker, DATABASE_POOL_MAX: '6' }).DATABASE_POOL_MAX).toBe(
      6,
    );
    expect(parseEnv(apiEnvSchema, { ...api, DATABASE_POOL_MAX: '4' }).DATABASE_POOL_MAX).toBe(4);
    for (const bad of ['0', '21', 'many', '2.5']) {
      expect(problems(workerEnvSchema, { ...worker, DATABASE_POOL_MAX: bad })).toHaveLength(1);
      expect(problems(apiEnvSchema, { ...api, DATABASE_POOL_MAX: bad })).toHaveLength(1);
    }
  });

  it('has no health port unless PORT is set, and takes a real port number', () => {
    expect(parseEnv(workerEnvSchema, worker).PORT).toBeUndefined();
    expect(parseEnv(workerEnvSchema, { ...worker, PORT: '8080' }).PORT).toBe(8080);
    for (const bad of ['0', '70000', 'http', '80.5']) {
      expect(problems(workerEnvSchema, { ...worker, PORT: bad })).toHaveLength(1);
    }
  });
});

describe('adminEnvSchema', () => {
  const admin = {
    DATABASE_URL_ADMIN: 'postgres://vmgs_owner:pw@db:5432/vmgs',
    DB_PASSWORD_WORKER: 'a'.repeat(48),
  };

  it('needs the owner URL and the worker password; the other passwords are optional', () => {
    expect(problems(adminEnvSchema, admin)).toEqual([]);
    expect(
      problems(adminEnvSchema, {
        ...admin,
        DB_PASSWORD_API: 'b'.repeat(48),
        DB_PASSWORD_BACKUP: 'c'.repeat(48),
      }),
    ).toEqual([]);
    expect(problems(adminEnvSchema, { DATABASE_URL_ADMIN: admin.DATABASE_URL_ADMIN })).toEqual([
      'DB_PASSWORD_WORKER: Invalid input: expected string, received undefined',
    ]);
  });

  it('refuses a short password and one that would need escaping in a URL', () => {
    for (const password of [
      'short',
      'a'.repeat(23),
      'a'.repeat(129),
      `${'a'.repeat(30)}@`,
      `${'a'.repeat(30)}/x`,
    ]) {
      expect(problems(adminEnvSchema, { ...admin, DB_PASSWORD_WORKER: password })).toHaveLength(1);
    }
    for (const password of ['a'.repeat(24), 'a'.repeat(128)]) {
      expect(problems(adminEnvSchema, { ...admin, DB_PASSWORD_WORKER: password })).toEqual([]);
    }
  });

  it('does not echo a refused password', () => {
    const text = problems(adminEnvSchema, { ...admin, DB_PASSWORD_API: 'hunter2-hunter2@' }).join(
      '\n',
    );
    expect(text).toContain('DB_PASSWORD_API');
    expect(text).not.toContain('hunter2');
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
    DATABASE_URL_BACKUP: 'postgres://vmgs_backup:pw@db:5432/vmgs',
    BACKUP_AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
    BACKUP_RCLONE_REMOTE: 'oci:vmgs-backups/db',
  };

  it('accepts an age public key and an rclone remote', () => {
    expect(problems(backupEnvSchema, backup)).toEqual([]);
  });

  it('connects as the backup role and as no other', () => {
    expect(
      problems(backupEnvSchema, {
        ...backup,
        DATABASE_URL_BACKUP: 'postgres://vmgs_worker:pw@db:5432/vmgs',
      }),
    ).toEqual(['DATABASE_URL_BACKUP: must connect as database role vmgs_backup']);
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
