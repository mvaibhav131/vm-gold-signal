import { describe, expect, it } from 'vitest';

import { pemOf, poolConfigOf } from './pool';

const URL_WITH_SSLMODE =
  'postgres://vmgs_worker:pw@pg-1.aivencloud.com:12345/defaultdb?sslmode=require';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('pemOf', () => {
  it('turns written \\n into line breaks, trims, and ends with one line break', () => {
    expect(pemOf('-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----')).toBe(
      `${PEM}\n`,
    );
    expect(pemOf(`  ${PEM}\n\n`)).toBe(`${PEM}\n`);
  });
});

describe('poolConfigOf', () => {
  it('leaves the URL alone and has no ssl option without a CA (a URL with ?sslmode keeps working as it did)', () => {
    expect(poolConfigOf(URL_WITH_SSLMODE)).toEqual({ connectionString: URL_WITH_SSLMODE, max: 10 });
    expect(poolConfigOf(URL_WITH_SSLMODE, { max: 3 }).max).toBe(3);
  });

  it('with a CA gives a verified TLS connection and drops the sslmode of the URL, which would override it', () => {
    const config = poolConfigOf(URL_WITH_SSLMODE, { max: 2, ca: PEM });
    expect(config.ssl).toEqual({ ca: `${PEM}\n`, rejectUnauthorized: true });
    expect(config.connectionString).toBe(
      'postgres://vmgs_worker:pw@pg-1.aivencloud.com:12345/defaultdb',
    );
    expect(config.max).toBe(2);
  });

  it('drops every sslmode-like setting and keeps the other settings, the user, the password, the host and the port', () => {
    const config = poolConfigOf(
      'postgres://u:p%40ss@host:6543/db?sslmode=verify-full&sslrootcert=/x.pem&application_name=vmgs&uselibpqcompat=true',
      { ca: PEM },
    );
    const url = new URL(config.connectionString);
    expect([...url.searchParams.keys()]).toEqual(['application_name']);
    expect(url.username).toBe('u');
    expect(url.password).toBe('p%40ss');
    expect(url.host).toBe('host:6543');
    expect(url.pathname).toBe('/db');
  });

  it('never turns verification off', () => {
    expect(poolConfigOf(URL_WITH_SSLMODE, { ca: PEM }).ssl?.rejectUnauthorized).toBe(true);
    expect(poolConfigOf(URL_WITH_SSLMODE.replace('require', 'no-verify'), { ca: PEM }).ssl).toEqual(
      {
        ca: `${PEM}\n`,
        rejectUnauthorized: true,
      },
    );
  });
});
