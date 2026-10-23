import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { failureOf, query, type TestDatabase } from '../test/database';
import {
  STRATEGY_ID,
  buildInsert,
  insert,
  outcomeRow,
  scalar,
  signalRow,
  strategyVersionRow,
} from '../test/fixtures';
import { migratedDatabase } from '../test/setup';

// The privilege split of 01_HLD section 8 as a matrix. It restates migration 0002 on purpose: a
// change of a grant must change both places, and a new table fails the test until it has a row here.

const S = 'S';
const readOnly = Object.fromEntries(
  [
    'ticks',
    'candles',
    'feed_incidents',
    'strategy_versions',
    'experiments',
    'signals',
    'signal_state',
    'signal_events',
    'signal_outcomes',
    'signal_autopsies',
    'rejections',
    'stats_bucket',
    'stats_monthly',
    'evidence_group_stats',
    'failure_cause_stats',
    'macro_events',
    'news_sources',
    'news_items',
    'market_events',
    'news_impact_samples',
    'news_topic_stats',
    'worker_heartbeats',
    'maintenance_runs',
    'signal_history_v',
    'storage_usage_v',
  ].map((table) => [table, S]),
);

const WORKER: Record<string, string> = {
  ticks: 'SI',
  signals: 'SI',
  signal_events: 'SI',
  signal_outcomes: 'SI',
  experiments: 'S',
  signal_history_v: 'S',
  storage_usage_v: 'S',
  strategy_versions: 'SIU',
  signal_autopsies: 'SIU',
  stats_bucket: 'SIU',
  stats_monthly: 'SIU',
  evidence_group_stats: 'SIU',
  failure_cause_stats: 'SIU',
  macro_events: 'SIU',
  news_sources: 'SIU',
  news_impact_samples: 'SIU',
  news_topic_stats: 'SIU',
  app_settings: 'SIU',
  worker_heartbeats: 'SIU',
  candles: 'SIUD',
  feed_incidents: 'SIUD',
  signal_state: 'SIUD',
  notification_outbox: 'SIUD',
  news_items: 'SIUD',
  maintenance_runs: 'SIUD',
  rejections: 'SID',
  market_events: 'SID',
  push_subscriptions: 'SUD',
  auth_owner: '',
  auth_sessions: '',
  login_attempts: '',
  security_audit_events: '',
  schema_migrations: '',
};

const API: Record<string, string> = {
  ...readOnly,
  auth_owner: 'SIUD',
  auth_sessions: 'SIUD',
  login_attempts: 'SIUD',
  security_audit_events: 'SIUD',
  app_settings: 'SIUD',
  push_subscriptions: 'SIUD',
  notification_outbox: 'SI',
  schema_migrations: '',
};

const PRIVILEGES = [
  ['S', 'SELECT'],
  ['I', 'INSERT'],
  ['U', 'UPDATE'],
  ['D', 'DELETE'],
] as const;

let database: TestDatabase;
let owner: string;
let worker: string;
let api: string;
const stranger = `stranger_${randomBytes(4).toString('hex')}`;
let strangerUrl: string;

beforeAll(async () => {
  database = await migratedDatabase();
  owner = database.url;
  await query(owner, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  await query(owner, "ALTER ROLE vmgs_api LOGIN PASSWORD 'api-pass'");
  await query(owner, `CREATE ROLE ${stranger} LOGIN PASSWORD 'stranger-pass'`);
  worker = database.urlFor('vmgs_worker', 'worker-pass');
  api = database.urlFor('vmgs_api', 'api-pass');
  strangerUrl = database.urlFor(stranger, 'stranger-pass');
});

afterAll(async () => {
  await database.drop();
  await query(inject('pgAdminUrl'), `DROP ROLE IF EXISTS ${stranger}`);
});

async function relations(): Promise<string[]> {
  const rows = await query<{ relname: string }>(
    owner,
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND NOT c.relispartition
     ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}

async function grantsOf(role: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relation of await relations()) {
    let letters = '';
    for (const [letter, privilege] of PRIVILEGES) {
      const allowed = await scalar<boolean>(owner, 'SELECT has_table_privilege($1, $2, $3)', [
        role,
        `public.${relation}`,
        privilege,
      ]);
      if (allowed) letters += letter;
    }
    result[relation] = letters;
  }
  return result;
}

describe('privilege matrix', () => {
  it('has an entry for every table and view (a new table needs a decision)', async () => {
    const names = await relations();
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      expect(WORKER, `vmgs_worker matrix: ${name}`).toHaveProperty(name);
      expect(API, `vmgs_api matrix: ${name}`).toHaveProperty(name);
    }
  });

  it('gives vmgs_worker exactly the documented privileges', async () => {
    const actual = await grantsOf('vmgs_worker');
    for (const [name, letters] of Object.entries(actual))
      expect([name, letters]).toEqual([name, WORKER[name]]);
  });

  it('gives vmgs_api exactly the documented privileges', async () => {
    const actual = await grantsOf('vmgs_api');
    for (const [name, letters] of Object.entries(actual))
      expect([name, letters]).toEqual([name, API[name]]);
  });

  it('never gives a role TRUNCATE, REFERENCES or TRIGGER on anything', async () => {
    for (const role of ['vmgs_worker', 'vmgs_api']) {
      for (const relation of await relations()) {
        for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const allowed = await scalar<boolean>(owner, 'SELECT has_table_privilege($1, $2, $3)', [
            role,
            `public.${relation}`,
            privilege,
          ]);
          expect(allowed, `${role} ${privilege} ${relation}`).toBe(false);
        }
      }
    }
  });

  it('keeps the auth tables away from the worker and the immutable tables away from the api', async () => {
    const worker = await grantsOf('vmgs_worker');
    for (const table of [
      'auth_owner',
      'auth_sessions',
      'login_attempts',
      'security_audit_events',
    ]) {
      expect(worker[table]).toBe('');
    }
    const api = await grantsOf('vmgs_api');
    for (const table of ['signals', 'signal_events', 'signal_outcomes']) {
      expect(api[table]).toBe('S');
    }
    for (const table of ['signals', 'signal_events', 'signal_outcomes']) {
      expect(worker[table]).toBe('SI');
    }
  });

  it('gives INSERT only together with USAGE on the sequences of the table', async () => {
    const sequences = await query<{ relname: string; seq: string }>(
      owner,
      `SELECT c.relname, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL`,
    );
    expect(sequences.length).toBeGreaterThanOrEqual(8);
    for (const [role, matrix] of [
      ['vmgs_worker', WORKER],
      ['vmgs_api', API],
    ] as const) {
      for (const { relname, seq } of sequences) {
        const canInsert = (matrix[relname] ?? '').includes('I');
        const canUse = await scalar<boolean>(
          owner,
          "SELECT has_sequence_privilege($1, $2, 'USAGE')",
          [role, seq],
        );
        expect(canUse, `${role} usage on ${seq}`).toBe(canInsert);
      }
    }
  });
});

describe('the application roles are plain roles', () => {
  it('are not superusers and cannot create roles, databases or bypass row security', async () => {
    const rows = await query<Record<string, boolean>>(
      owner,
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname IN ('vmgs_worker', 'vmgs_api')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([
        row.rolsuper,
        row.rolcreaterole,
        row.rolcreatedb,
        row.rolreplication,
        row.rolbypassrls,
      ]).toEqual([false, false, false, false, false]);
    }
  });

  it('cannot create tables or roles, or drop what the owner made', async () => {
    for (const url of [worker, api]) {
      expect((await failureOf(url, 'CREATE TABLE intruder (id integer)'))?.code).toBe('42501');
      expect((await failureOf(url, 'CREATE ROLE intruder'))?.code).toBe('42501');
      expect((await failureOf(url, 'DROP TABLE signals'))?.code).toBe('42501');
      expect((await failureOf(url, 'ALTER TABLE signals DISABLE TRIGGER ALL'))?.code).toBe('42501');
      expect((await failureOf(url, 'SELECT * FROM schema_migrations'))?.code).toBe('42501');
    }
  });
});

describe('vmgs_worker at work', () => {
  let signalId: string;

  it('writes strategy versions, signals, events and outcomes', async () => {
    await insert(worker, 'strategy_versions', strategyVersionRow());
    const signal = await insert(worker, 'signals', signalRow({ setup_key: 'worker-1' }));
    signalId = String(signal.id);
    await insert(worker, 'signal_events', {
      signal_id: signalId,
      event_type: 'CREATED',
      event_at: '2026-10-23T06:10:00Z',
    });
    await insert(worker, 'signal_outcomes', outcomeRow(signalId));
    expect(await scalar(owner, 'SELECT count(*)::int FROM signals')).toBe(1);
  });

  it('cannot change or delete a signal, event or outcome: no grant, before any trigger', async () => {
    expect((await failureOf(worker, 'UPDATE signals SET entry = 1'))?.code).toBe('42501');
    expect((await failureOf(worker, 'DELETE FROM signal_events'))?.code).toBe('42501');
    expect((await failureOf(worker, "UPDATE signal_outcomes SET exit_reason = 'x'"))?.code).toBe(
      '42501',
    );
    expect((await failureOf(worker, 'TRUNCATE signals CASCADE'))?.code).toBe('42501');
  });

  it('moves a strategy through its status but cannot change its config (trigger)', async () => {
    expect(
      await failureOf(worker, "UPDATE strategy_versions SET status = 'FORWARD_TESTING'"),
    ).toBeNull();
    const failure = await failureOf(
      worker,
      `UPDATE strategy_versions SET config = '{}'::jsonb WHERE id = '${STRATEGY_ID}'`,
    );
    expect(failure?.code).toBe('P0001');
  });

  it('keeps and prunes candles and writes settings', async () => {
    const candle =
      "INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete) VALUES ('XAUUSD', '1m', now(), 1, 2, 1, 2, true)";
    expect(await failureOf(worker, candle)).toBeNull();
    expect(await failureOf(worker, "DELETE FROM candles WHERE tf = '1m'")).toBeNull();
    expect(
      await failureOf(
        worker,
        "INSERT INTO app_settings (key, value) VALUES ('telegramChat', '{\"id\": 1}')",
      ),
    ).toBeNull();
  });

  it('cannot read the owner account or the sessions', async () => {
    expect((await failureOf(worker, 'SELECT * FROM auth_owner'))?.code).toBe('42501');
    expect((await failureOf(worker, 'SELECT * FROM auth_sessions'))?.code).toBe('42501');
    expect(
      (await failureOf(worker, "INSERT INTO login_attempts (ip_hash, success) VALUES ('x', true)"))
        ?.code,
    ).toBe('42501');
  });

  it('maintains the tick partitions without any right to create tables, and the owner keeps them', async () => {
    expect(await scalar(worker, 'SELECT ensure_tick_partitions()')).toBe(4);
    expect(
      await failureOf(
        worker,
        "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES (now(), now(), 'XAUUSD', 4017.2, 4017.37)",
      ),
    ).toBeNull();
    const owners = await query<{ owner: string }>(
      owner,
      `SELECT DISTINCT t.tableowner AS owner FROM pg_tables t WHERE t.tablename LIKE 'ticks\\_%' OR t.tablename = 'signals'`,
    );
    expect(owners).toHaveLength(1);
    expect(await scalar(worker, 'SELECT drop_old_tick_partitions(14)')).toBe(0);
  });
});

describe('vmgs_api at work', () => {
  it('reads signals, outcomes and the views', async () => {
    expect(await scalar(api, 'SELECT count(*)::int FROM signals')).toBe(1);
    expect(await scalar(api, 'SELECT count(*)::int FROM signal_outcomes')).toBe(1);
    expect(await scalar(api, 'SELECT count(*)::int FROM signal_history_v')).toBe(1);
    expect(Number(await scalar(api, 'SELECT count(*) FROM storage_usage_v'))).toBeGreaterThan(10);
  });

  it('cannot write a signal, an event, an outcome, a strategy or a tick', async () => {
    const attempt = buildInsert('signals', signalRow({ setup_key: 'api-1' }));
    expect((await failureOf(api, attempt.sql, attempt.values))?.code).toBe('42501');
    expect(
      (
        await failureOf(
          api,
          "INSERT INTO signal_events (signal_id, event_type, event_at) VALUES (gen_random_uuid(), 'CREATED', now())",
        )
      )?.code,
    ).toBe('42501');
    expect((await failureOf(api, "UPDATE strategy_versions SET status = 'PAUSED'"))?.code).toBe(
      '42501',
    );
    expect(
      (
        await failureOf(
          api,
          "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES (now(), now(), 'XAUUSD', 1, 2)",
        )
      )?.code,
    ).toBe('42501');
    expect((await failureOf(api, 'UPDATE signals SET entry = 1'))?.code).toBe('42501');
  });

  it('writes the owner account, sessions, login attempts and the security audit', async () => {
    expect(
      await failureOf(
        api,
        "INSERT INTO auth_owner (username, password_hash) VALUES ('owner', 'hash')",
      ),
    ).toBeNull();
    expect(
      await failureOf(
        api,
        "INSERT INTO auth_sessions (id_hash, expires_at) VALUES ('s1', now() + interval '12 hours')",
      ),
    ).toBeNull();
    expect(
      await failureOf(api, "INSERT INTO login_attempts (ip_hash, success) VALUES ('ip', false)"),
    ).toBeNull();
    expect(
      await failureOf(
        api,
        "INSERT INTO security_audit_events (event_type, success) VALUES ('LOGIN', true)",
      ),
    ).toBeNull();
    expect(
      await failureOf(api, "UPDATE auth_sessions SET revoked_at = now() WHERE id_hash = 's1'"),
    ).toBeNull();
  });

  it('writes settings and push subscriptions, and can queue a test message but not edit one', async () => {
    expect(
      await failureOf(api, "INSERT INTO app_settings (key, value) VALUES ('displayTz', '\"UTC\"')"),
    ).toBeNull();
    expect(
      await failureOf(
        api,
        "UPDATE app_settings SET value = '\"Asia/Kolkata\"' WHERE key = 'displayTz'",
      ),
    ).toBeNull();
    expect(
      await failureOf(
        api,
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/1', 'k', 'a')",
      ),
    ).toBeNull();
    expect(
      await failureOf(
        api,
        "INSERT INTO notification_outbox (event_key, channel, kind, payload) VALUES ('test:1', 'telegram', 'TEST', '{}')",
      ),
    ).toBeNull();
    expect((await failureOf(api, "UPDATE notification_outbox SET status = 'SENT'"))?.code).toBe(
      '42501',
    );
    expect((await failureOf(api, 'DELETE FROM notification_outbox'))?.code).toBe('42501');
  });

  it('cannot run the partition functions', async () => {
    const failure = await failureOf(api, 'SELECT ensure_tick_partitions()');
    expect(failure?.code).toBe('42501');
    expect(failure?.message).toContain('permission denied for function ensure_tick_partitions');
    expect((await failureOf(api, 'SELECT drop_old_tick_partitions(1)'))?.code).toBe('42501');
  });
});

describe('a role without grants', () => {
  it('sees nothing and cannot call the partition functions (PUBLIC has no access)', async () => {
    expect((await failureOf(strangerUrl, 'SELECT * FROM signals'))?.code).toBe('42501');
    expect((await failureOf(strangerUrl, 'SELECT * FROM app_settings'))?.code).toBe('42501');
    expect((await failureOf(strangerUrl, 'SELECT ensure_tick_partitions()'))?.code).toBe('42501');
    expect((await failureOf(strangerUrl, 'CREATE TABLE intruder (id integer)'))?.code).toBe(
      '42501',
    );
  });
});
