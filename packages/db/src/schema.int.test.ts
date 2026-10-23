import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { failureOf, query, type TestDatabase } from '../test/database';
import {
  Json,
  buildInsert,
  insert,
  outcomeRow,
  scalar,
  signalRow,
  strategyVersionRow,
  type Row,
} from '../test/fixtures';
import { migratedDatabase } from '../test/setup';

// These run as the schema owner (a superuser): a rule that holds here is enforced by the database
// itself (trigger or constraint), not just by a missing privilege.

let database: TestDatabase;
let url: string;
let setupCounter = 0;

beforeAll(async () => {
  database = await migratedDatabase();
  url = database.url;
  await insert(url, 'strategy_versions', strategyVersionRow());
});

afterAll(async () => {
  await database.drop();
});

/** A signal with its own setup_key (one signal per strategy, side and setup). */
async function newSignal(overrides: Row = {}): Promise<string> {
  setupCounter += 1;
  const row = await insert(
    url,
    'signals',
    signalRow({ setup_key: `setup-${String(setupCounter)}`, ...overrides }),
  );
  return String(row.id);
}

describe('append-only tables reject UPDATE, DELETE and TRUNCATE', () => {
  let signalId: string;

  beforeAll(async () => {
    signalId = await newSignal();
    await insert(url, 'signal_events', {
      signal_id: signalId,
      event_type: 'CREATED',
      event_at: '2026-10-23T06:10:00Z',
    });
    await insert(url, 'signal_outcomes', outcomeRow(signalId));
  });

  const tables = [
    {
      table: 'signals',
      update: 'UPDATE signals SET entry = 1',
      remove: 'DELETE FROM signals',
      truncateCode: '0A000',
    },
    {
      table: 'signal_events',
      update: 'UPDATE signal_events SET price = 1',
      remove: 'DELETE FROM signal_events',
      truncateCode: 'P0001',
    },
    {
      table: 'signal_outcomes',
      update: "UPDATE signal_outcomes SET exit_reason = 'x'",
      remove: 'DELETE FROM signal_outcomes',
      truncateCode: 'P0001',
    },
  ];

  for (const { table, update, remove, truncateCode } of tables) {
    it(`${table}: UPDATE is rejected`, async () => {
      const failure = await failureOf(url, update);
      expect(failure?.code).toBe('P0001');
      expect(failure?.message).toContain(`UPDATE on ${table} is not allowed (append-only table)`);
    });

    it(`${table}: DELETE is rejected`, async () => {
      const failure = await failureOf(url, remove);
      expect(failure?.code).toBe('P0001');
      expect(failure?.message).toContain(`DELETE on ${table} is not allowed (append-only table)`);
    });

    // signals is referenced by foreign keys, so Postgres refuses a plain TRUNCATE (0A000) before
    // the trigger is reached; the trigger itself is proven by the statement further down.
    it(`${table}: TRUNCATE is rejected`, async () => {
      const failure = await failureOf(url, `TRUNCATE ${table}`);
      expect(failure?.code).toBe(truncateCode);
      if (truncateCode === 'P0001') {
        expect(failure?.message).toContain(
          `TRUNCATE on ${table} is not allowed (append-only table)`,
        );
      }
    });
  }

  it('the TRUNCATE trigger on signals fires when the foreign keys allow the statement', async () => {
    const failure = await failureOf(
      url,
      'TRUNCATE signals, signal_state, signal_events, signal_outcomes, signal_autopsies, notification_outbox',
    );
    expect(failure?.code).toBe('P0001');
    expect(failure?.message).toContain('is not allowed (append-only table)');
  });

  it('TRUNCATE ... CASCADE and a multi-table TRUNCATE are rejected too', async () => {
    expect((await failureOf(url, 'TRUNCATE signals CASCADE'))?.code).toBe('P0001');
    expect((await failureOf(url, 'TRUNCATE signal_events, signal_outcomes'))?.code).toBe('P0001');
  });

  it('a rejected statement changes nothing', async () => {
    await failureOf(url, 'UPDATE signals SET entry = 1');
    await failureOf(url, 'DELETE FROM signals');
    const rows = await query<{ entry: string }>(url, 'SELECT entry FROM signals WHERE id = $1', [
      signalId,
    ]);
    expect(rows).toEqual([{ entry: '4017.370' }]);
    expect(
      await scalar(url, 'SELECT count(*)::int FROM signal_events WHERE signal_id = $1', [signalId]),
    ).toBe(1);
  });

  it('an UPDATE that changes no value is rejected as well (no silent no-ops)', async () => {
    expect((await failureOf(url, 'UPDATE signals SET entry = entry'))?.code).toBe('P0001');
  });

  it('mutable working tables stay mutable: signal_state can change and be deleted', async () => {
    await insert(url, 'signal_state', {
      signal_id: signalId,
      status: 'ACTIVE',
      stop_loss_current: '4010.900',
    });
    expect(
      await failureOf(url, "UPDATE signal_state SET status = 'TP1_HIT', tp1_hit_at = now()"),
    ).toBeNull();
    expect(await failureOf(url, 'DELETE FROM signal_state')).toBeNull();
  });
});

describe('strategy version config is immutable', () => {
  it('rejects a change of the config, the hash, the key or the version', async () => {
    for (const update of [
      `UPDATE strategy_versions SET config = '{"changed":true}'::jsonb`,
      `UPDATE strategy_versions SET config_hash = '${'b'.repeat(64)}'`,
      `UPDATE strategy_versions SET strategy_key = 'sweep_reversal'`,
      `UPDATE strategy_versions SET version = '0.2.0'`,
    ]) {
      const failure = await failureOf(url, update);
      expect(failure?.code, update).toBe('P0001');
      expect(failure?.message).toContain(
        'strategy version config is immutable; create a new version',
      );
    }
  });

  it('allows the status to move through its life cycle', async () => {
    for (const status of ['BACKTESTED', 'FORWARD_TESTING', 'VALIDATED', 'PAUSED', 'DRIFTED']) {
      expect(await failureOf(url, `UPDATE strategy_versions SET status = '${status}'`)).toBeNull();
    }
    await query(url, "UPDATE strategy_versions SET status = 'RESEARCH'");
  });

  it('allows a new version of the same strategy, never the same version twice', async () => {
    expect(
      await failureOf(
        url,
        "INSERT INTO strategy_versions (strategy_key, version, config, config_hash) VALUES ('trend_pullback', '0.2.0', '{}', 'c')",
      ),
    ).toBeNull();
    const duplicate = await failureOf(
      url,
      "INSERT INTO strategy_versions (strategy_key, version, config, config_hash) VALUES ('trend_pullback', '0.2.0', '{}', 'c')",
    );
    expect(duplicate?.code).toBe('23505');
  });
});

describe('tick partitions', () => {
  const dayOf = (offset: number) =>
    scalar<string>(
      url,
      "SELECT to_char(((now() AT TIME ZONE 'UTC')::date + $1::int), 'YYYYMMDD')",
      [offset],
    );

  const partitionNames = async () =>
    (
      await query<{ relname: string }>(
        url,
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ticks' ORDER BY c.relname`,
      )
    ).map((r) => r.relname);

  it('rejects a tick while no partition exists for its day', async () => {
    const failure = await failureOf(
      url,
      "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES (now(), now(), 'XAUUSD', 4017.2, 4017.37)",
    );
    expect(failure?.code).toBe('23514');
    expect(failure?.message).toContain('no partition of relation "ticks" found for row');
  });

  it('ensure_tick_partitions creates yesterday, today and two days ahead, and only once', async () => {
    expect(await scalar(url, 'SELECT ensure_tick_partitions()')).toBe(4);
    const expected = await Promise.all(
      [-1, 0, 1, 2].map(async (offset) => `ticks_${await dayOf(offset)}`),
    );
    expect(await partitionNames()).toEqual(expected);
    expect(await scalar(url, 'SELECT ensure_tick_partitions()')).toBe(0);
    expect(await scalar(url, 'SELECT ensure_tick_partitions(4)')).toBe(2);
  });

  it('stores a tick in the partition of its UTC day and returns it', async () => {
    await query(
      url,
      "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES (now(), now(), 'XAUUSD', 4017.200, 4017.370)",
    );
    const today = await dayOf(0);
    expect(await scalar(url, `SELECT count(*)::int FROM ticks_${today}`)).toBe(1);
    expect(await scalar(url, 'SELECT count(*)::int FROM ticks')).toBe(1);
  });

  it('rejects ask below bid', async () => {
    const failure = await failureOf(
      url,
      "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES (now(), now(), 'XAUUSD', 4018, 4017)",
    );
    expect(failure?.code).toBe('23514');
  });

  it('drop_old_tick_partitions drops whole old days and keeps the rest', async () => {
    const addPartition = async (daysAgo: number) => {
      const day = await dayOf(-daysAgo);
      const nextDay = await dayOf(-daysAgo + 1);
      const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} 00:00:00+00`;
      await query(
        url,
        `CREATE TABLE ticks_${day} PARTITION OF ticks FOR VALUES FROM ('${iso(day)}') TO ('${iso(nextDay)}')`,
      );
      await query(
        url,
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask)
         VALUES ('${iso(day)}'::timestamptz + interval '1 hour', now(), 'XAUUSD', 4000, 4000.2)`,
      );
      return day;
    };
    const old = await addPartition(20);
    const recent = await addPartition(10);

    expect(await scalar(url, 'SELECT drop_old_tick_partitions(14)')).toBe(1);
    const names = await partitionNames();
    expect(names).not.toContain(`ticks_${old}`);
    expect(names).toContain(`ticks_${recent}`);
    expect(names).toContain(`ticks_${await dayOf(0)}`);
    expect(
      await scalar(url, `SELECT count(*)::int FROM ticks WHERE ts < now() - interval '14 days'`),
    ).toBe(0);
    expect(await scalar(url, `SELECT count(*)::int FROM ticks_${recent}`)).toBe(1);
    expect(await scalar(url, 'SELECT drop_old_tick_partitions(14)')).toBe(0);
  });
});

describe('constraints reject impossible rows', () => {
  const cases: { name: string; run: () => Promise<{ code: string } | null>; code: string }[] = [
    // signals: the trade maths and the vocabulary
    {
      name: 'a BUY with the stop above the entry',
      code: '23514',
      run: () =>
        failureOf(url, ...sqlOf('signals', signalRow({ stop_loss: '4020.000', setup_key: 'c1' }))),
    },
    {
      name: 'a BUY with tp1 below the entry',
      code: '23514',
      run: () =>
        failureOf(url, ...sqlOf('signals', signalRow({ tp1: '4010.000', setup_key: 'c2' }))),
    },
    {
      name: 'a SELL with the levels of a BUY',
      code: '23514',
      run: () => failureOf(url, ...sqlOf('signals', signalRow({ side: 'SELL', setup_key: 'c3' }))),
    },
    {
      name: 'a risk distance of zero',
      code: '23514',
      run: () =>
        failureOf(url, ...sqlOf('signals', signalRow({ risk_distance: '0', setup_key: 'c4' }))),
    },
    {
      name: 'a quality score above 100',
      code: '23514',
      run: () =>
        failureOf(
          url,
          ...sqlOf('signals', signalRow({ quality_score: '100.01', setup_key: 'c5' })),
        ),
    },
    {
      name: 'a quality score below 0',
      code: '23514',
      run: () =>
        failureOf(url, ...sqlOf('signals', signalRow({ quality_score: '-1', setup_key: 'c6' }))),
    },
    {
      name: 'a side other than BUY or SELL',
      code: '23514',
      run: () => failureOf(url, ...sqlOf('signals', signalRow({ side: 'HOLD', setup_key: 'c7' }))),
    },
    {
      name: 'a mode other than LIVE, SIMULATED or BACKTEST',
      code: '23514',
      run: () => failureOf(url, ...sqlOf('signals', signalRow({ mode: 'PAPER', setup_key: 'c8' }))),
    },
    {
      name: 'a signal of a strategy version that does not exist',
      code: '23503',
      run: () =>
        failureOf(
          url,
          ...sqlOf(
            'signals',
            signalRow({
              strategy_version_id: '00000000-0000-4000-8000-000000000000',
              setup_key: 'c9',
            }),
          ),
        ),
    },
    {
      name: 'a missing required field (no explanation)',
      code: '23502',
      run: () =>
        failureOf(
          url,
          ...sqlOf('signals', withoutKey(signalRow({ setup_key: 'c10' }), 'explanation')),
        ),
    },
    // signal lifecycle
    {
      name: 'a signal state with an unknown status',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO signal_state (signal_id, status, stop_loss_current) VALUES (gen_random_uuid(), 'WAITING', 1)",
        ),
    },
    {
      name: 'a signal event of an unknown type',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO signal_events (signal_id, event_type, event_at) VALUES (gen_random_uuid(), 'REPAINTED', now())",
        ),
    },
    {
      name: 'an outcome with an unknown result',
      code: '23514',
      run: () =>
        failureOf(
          url,
          ...sqlOf(
            'signal_outcomes',
            outcomeRow('00000000-0000-4000-8000-000000000000', { result: 'MAYBE' }),
          ),
        ),
    },
    {
      name: 'a counted outcome without net R',
      code: '23514',
      run: () =>
        failureOf(
          url,
          ...sqlOf(
            'signal_outcomes',
            outcomeRow('00000000-0000-4000-8000-000000000000', { realized_r_net: null }),
          ),
        ),
    },
    // market data
    {
      name: 'a candle on an unknown timeframe',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete) VALUES ('XAUUSD', '2m', now(), 1, 2, 1, 2, true)",
        ),
    },
    {
      name: 'a candle whose high is below its low',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete) VALUES ('XAUUSD', '5m', now(), 1, 1, 2, 1, true)",
        ),
    },
    {
      name: 'a candle from an unknown source',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete, source) VALUES ('XAUUSD', '5m', now(), 1, 2, 1, 2, true, 'manual')",
        ),
    },
    {
      name: 'a feed incident of an unknown kind',
      code: '23514',
      run: () =>
        failureOf(url, "INSERT INTO feed_incidents (kind, started_at) VALUES ('EXPLOSION', now())"),
    },
    // alerts
    {
      name: 'an outbox channel other than telegram or webpush',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO notification_outbox (event_key, channel, kind, payload) VALUES ('k1', 'sms', 'TEST', '{}')",
        ),
    },
    {
      name: 'an outbox status that does not exist',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO notification_outbox (event_key, channel, kind, payload, status) VALUES ('k2', 'telegram', 'TEST', '{}', 'LOST')",
        ),
    },
    // single owner and settings
    {
      name: 'a second owner account',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO auth_owner (id, username, password_hash) VALUES (2, 'second', 'x')",
        ),
    },
    // news
    {
      name: 'a headline summary longer than 300 characters',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO news_sources (key, name, tier) VALUES ('bbc', 'BBC', 2) ON CONFLICT DO NOTHING",
        ).then(() =>
          failureOf(
            url,
            `INSERT INTO news_items (source_key, url_hash, title, url, summary, impact, cluster_id, classifier_version) VALUES ('bbc', 'h1', 't', 'https://x', '${'a'.repeat(301)}', 'LOW', gen_random_uuid(), 'v1')`,
          ),
        ),
    },
    {
      name: 'a news source of tier 4',
      code: '23514',
      run: () =>
        failureOf(url, "INSERT INTO news_sources (key, name, tier) VALUES ('t4', 'Tier four', 4)"),
    },
    {
      name: 'a calendar importance written in capitals',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO macro_events (source, source_event_id, scheduled_at, name, importance) VALUES ('s', 'e1', now(), 'CPI', 'HIGH')",
        ),
    },
    {
      name: 'a market event of an unknown kind',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO market_events (kind, detected_at, window_s, move_usd, move_atr) VALUES ('CRASH', now(), 60, 1, 1)",
        ),
    },
    // statistics
    {
      name: 'a statistics bucket at level 5',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO stats_bucket (scope, level, bucket_key) VALUES ('FORWARD', 5, 'k')",
        ),
    },
    {
      name: 'a statistics bucket of an unknown scope',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO stats_bucket (scope, level, bucket_key) VALUES ('LIVE', 0, 'k')",
        ),
    },
    {
      name: 'a group state that does not exist',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO evidence_group_stats (scope, strategy_key, group_key, state) VALUES ('FORWARD', 's', 'g', 'GREAT')",
        ),
    },
    {
      name: 'a strategy status that does not exist',
      code: '23514',
      run: () =>
        failureOf(
          url,
          "INSERT INTO strategy_versions (strategy_key, version, status, config, config_hash) VALUES ('x', '1.0.0', 'LIVE', '{}', 'h')",
        ),
    },
  ];

  it.each(cases)('rejects $name', async ({ run, code }) => {
    const failure = await run();
    expect(failure?.code).toBe(code);
  });

  it('rejects the same setup twice for one strategy and side, but allows the other side', async () => {
    await insert(url, 'signals', signalRow({ setup_key: 'dedupe-1' }));
    const duplicate = await failureOf(
      url,
      ...sqlOf('signals', signalRow({ setup_key: 'dedupe-1' })),
    );
    expect(duplicate?.code).toBe('23505');
    const otherSide = signalRow({
      setup_key: 'dedupe-1',
      side: 'SELL',
      stop_loss: '4023.840',
      tp1: '4010.900',
      tp2: '4004.000',
    });
    expect(await failureOf(url, ...sqlOf('signals', otherSide))).toBeNull();
  });

  it('keeps an outbox message once per event key and channel (idempotency)', async () => {
    const sql =
      "INSERT INTO notification_outbox (event_key, channel, kind, payload) VALUES ('signal:1:confirmed', 'telegram', 'SIGNAL_NEW', '{}')";
    expect(await failureOf(url, sql)).toBeNull();
    expect((await failureOf(url, sql))?.code).toBe('23505');
    expect(await failureOf(url, sql.replace("'telegram'", "'webpush'"))).toBeNull();
  });

  it('keeps one candle per symbol, timeframe and open time', async () => {
    const sql =
      "INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete) VALUES ('XAUUSD', '5m', '2026-10-23T06:05:00Z', 1, 2, 1, 2, true)";
    expect(await failureOf(url, sql)).toBeNull();
    expect((await failureOf(url, sql))?.code).toBe('23505');
  });

  it('keeps exactly one owner row', async () => {
    const sql = "INSERT INTO auth_owner (username, password_hash) VALUES ('owner', 'hash')";
    expect(await failureOf(url, sql)).toBeNull();
    expect((await failureOf(url, sql))?.code).toBe('23505');
  });
});

describe('column behaviour', () => {
  it('numbers signals with an identity column that cannot be set by hand', async () => {
    const a = await newSignal();
    const b = await newSignal();
    const seqs = await query<{ seq: string }>(
      url,
      'SELECT seq FROM signals WHERE id = ANY($1::uuid[]) ORDER BY seq',
      [[a, b]],
    );
    expect(Number(seqs[1]?.seq)).toBeGreaterThan(Number(seqs[0]?.seq));
    const failure = await failureOf(
      url,
      ...sqlOf('signals', signalRow({ seq: 999, setup_key: 'manual-seq' })),
    );
    expect(failure?.code).toBe('428C9');
  });

  it('computes is_win from the counted flag and the sign of net R', async () => {
    const win = await newSignal();
    const loss = await newSignal();
    const flat = await newSignal();
    const cancelled = await newSignal();
    await insert(url, 'signal_outcomes', outcomeRow(win));
    await insert(
      url,
      'signal_outcomes',
      outcomeRow(loss, { result: 'LOSS', realized_r_net: '-1.040', realized_r_gross: '-1.000' }),
    );
    await insert(
      url,
      'signal_outcomes',
      outcomeRow(flat, { result: 'TIME_EXIT', realized_r_net: '0.000' }),
    );
    await insert(
      url,
      'signal_outcomes',
      outcomeRow(cancelled, {
        result: 'CANCELLED',
        counts_in_stats: false,
        realized_r_net: null,
        realized_r_gross: null,
      }),
    );
    const rows = await query<{ signal_id: string; is_win: boolean }>(
      url,
      'SELECT signal_id, is_win FROM signal_outcomes WHERE signal_id = ANY($1::uuid[])',
      [[win, loss, flat, cancelled]],
    );
    const byId = new Map(rows.map((r) => [r.signal_id, r.is_win]));
    expect(byId.get(win)).toBe(true);
    expect(byId.get(loss)).toBe(false);
    expect(byId.get(flat)).toBe(false);
    expect(byId.get(cancelled)).toBe(false);
  });

  it('stores prices exactly with 3 decimals (numeric, no float error)', async () => {
    const id = await newSignal({
      entry: '4017.285',
      max_valid_entry: '4017.555',
      stop_loss: '4010.915',
      risk_distance: '6.370',
    });
    const rows = await query<{ entry: string; stop_loss: string }>(
      url,
      'SELECT entry, stop_loss FROM signals WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ entry: '4017.285', stop_loss: '4010.915' });
  });

  it('keeps every timestamp as timestamptz in UTC', async () => {
    const types = await query<{ table_name: string; data_type: string }>(
      url,
      `SELECT table_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type LIKE 'timestamp%' AND table_name NOT LIKE 'ticks_%'`,
    );
    expect(types.length).toBeGreaterThan(30);
    expect(types.filter((t) => t.data_type !== 'timestamp with time zone')).toEqual([]);
  });
});

describe('views', () => {
  it('signal_history_v shows an open signal, then its result once it is closed', async () => {
    const id = await newSignal({ evidence: new Json({ winRate: 0.58, n: 64 }) });
    await insert(url, 'signal_state', {
      signal_id: id,
      status: 'ACTIVE',
      stop_loss_current: '4010.900',
    });

    const open = await query<Row>(url, 'SELECT * FROM signal_history_v WHERE signal_id = $1', [id]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      strategy_key: 'trend_pullback',
      strategy_version: '0.1.0',
      side: 'BUY',
      state: 'ACTIVE',
      result: null,
      is_win: null,
      evidence_n: 64,
    });
    expect(Number(open[0]?.evidence_win_rate)).toBeCloseTo(0.58, 6);

    await query(url, 'DELETE FROM signal_state WHERE signal_id = $1', [id]);
    await insert(url, 'signal_outcomes', outcomeRow(id));
    const closed = await query<Row>(url, 'SELECT * FROM signal_history_v WHERE signal_id = $1', [
      id,
    ]);
    expect(closed[0]).toMatchObject({
      state: 'CLOSED',
      result: 'WIN',
      is_win: true,
      exit_reason: 'TP2',
    });
    expect(Number(closed[0]?.realized_r_net)).toBeCloseTo(1.47, 6);
  });

  it('storage_usage_v lists the tables and not the daily tick partitions', async () => {
    const rows = await query<{ table_name: string; total_bytes: string }>(
      url,
      'SELECT * FROM storage_usage_v',
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain('signals');
    expect(names).toContain('ticks');
    expect(names.filter((name) => name.startsWith('ticks_'))).toEqual([]);
    expect(Number(rows[0]?.total_bytes)).toBeGreaterThan(0);
  });
});

function sqlOf(table: string, row: Row): [string, unknown[]] {
  const { sql, values } = buildInsert(table, row);
  return [sql, values];
}

function withoutKey(row: Row, key: string): Row {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}
