import { randomUUID } from 'node:crypto';

import type { Review, StrategyKey } from '@vmgs/core';

import { marketCandles } from '../../../../packages/core/src/levels/test-data';
import type { PgApi } from './pgApi';
import { MINUTE_MS, outcomeOf, type SeedWorld } from './seedWorld';

const HOUR = 60 * MINUTE_MS;
const DAY = 24 * HOUR;

/** The price the signals of the seed were made at (the example of the docs): the candles and the simulated feed end near it. */
export const LIVE_PRICE = 4017.4;

const STRATEGIES: StrategyKey[] = [
  'trend_pullback',
  'sweep_reversal',
  'squeeze_retest',
  'trendline_retest',
  'pattern_breakout',
];
const SESSIONS = ['ASIA', 'LONDON', 'OVERLAP', 'NEW_YORK'] as const;
const REGIMES = ['TREND_UP', 'RANGE', 'TREND_DOWN', 'SQUEEZE'] as const;
const RESULTS = [
  'WIN',
  'LOSS',
  'WIN',
  'LOSS',
  'PARTIAL_WIN',
  'LOSS',
  'WIN',
  'TIME_EXIT',
  'LOSS',
  'WIN',
  'CANCELLED',
  'PARTIAL_WIN',
  'LOSS',
  'DATA_INVALID',
] as const;

const review = (primaryCause: Review['primaryCause']): Review => ({
  status: 'PRELIMINARY',
  primaryCause,
  causes: [{ code: primaryCause, evidence: { mfeR: 0.2 } }],
  weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
  counterfactual: null,
});

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Partitions of `ticks` for the days around `now`: the table has none by itself. */
export async function tickPartitions(api: PgApi, now: number): Promise<void> {
  for (const offset of [-2, -1, 0, 1]) {
    const from = day(now + offset * DAY);
    const to = day(now + (offset + 1) * DAY);
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_${from.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${from}') TO ('${to}')`,
    );
  }
}

interface Bar {
  openTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function aggregate(bars: readonly Bar[], ms: number): Bar[] {
  const out: Bar[] = [];
  for (const bar of bars) {
    const openTime = Math.floor(bar.openTime / ms) * ms;
    const last = out.at(-1);
    if (last?.openTime === openTime) {
      out[out.length - 1] = {
        openTime,
        o: last.o,
        h: Math.max(last.h, bar.h),
        l: Math.min(last.l, bar.l),
        c: bar.c,
      };
    } else {
      out.push({ ...bar, openTime });
    }
  }
  return out;
}

/** Candles of a market that has been open for twelve days, ending near `LIVE_PRICE`: what the chart and the levels read. */
async function candles(api: PgApi, now: number): Promise<number> {
  const raw = marketCandles(iso(now - 12 * DAY), iso(now), 7).map((bar) => ({
    openTime: bar.openTime,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
  }));
  const shift = LIVE_PRICE - (raw.at(-1)?.c ?? LIVE_PRICE);
  const five = raw
    .filter((bar) => bar.openTime + 5 * MINUTE_MS <= now)
    .map((bar) => ({
      openTime: bar.openTime,
      o: Math.round((bar.o + shift) * 1000) / 1000,
      h: Math.round((bar.h + shift) * 1000) / 1000,
      l: Math.round((bar.l + shift) * 1000) / 1000,
      c: Math.round((bar.c + shift) * 1000) / 1000,
    }));
  for (const [tf, ms] of [
    ['5m', 5 * MINUTE_MS],
    ['15m', 15 * MINUTE_MS],
    ['1h', HOUR],
  ] as const) {
    const bars = (ms === 5 * MINUTE_MS ? five : aggregate(five, ms)).filter(
      (bar) => bar.openTime + ms <= now,
    );
    await api.admin.query(
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, tick_count, complete)
       SELECT 'XAUUSD', $1, x.t, x.o, x.h, x.l, x.c, 60, true
         FROM unnest($2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[]) AS x(t, o, h, l, c)`,
      [
        tf,
        bars.map((bar) => new Date(bar.openTime)),
        bars.map((bar) => bar.o),
        bars.map((bar) => bar.h),
        bars.map((bar) => bar.l),
        bars.map((bar) => bar.c),
      ],
    );
  }
  return five.length;
}

/** Closed signals over the last 80 days (all strategies, sides, sessions and results), and two that are still open. */
async function signals(world: SeedWorld, now: number): Promise<void> {
  for (let i = 0; i < 38; i += 1) {
    const generatedAt = now - (80 - i * 2.05) * DAY + (i % 7) * HOUR;
    const result = RESULTS[i % RESULTS.length] ?? 'WIN';
    const strategy = STRATEGIES[i % STRATEGIES.length] ?? 'trend_pullback';
    const created = await world.createSignal({
      strategy,
      side: i % 3 === 0 ? 'SELL' : 'BUY',
      generatedAt,
      qualityScore: 65 + ((i * 7) % 28),
      draft: {
        session: SESSIONS[i % SESSIONS.length] ?? 'LONDON',
        regime: REGIMES[i % REGIMES.length] ?? 'RANGE',
      },
    });
    const minutes = 12 + ((i * 11) % 90);
    const closedAt = generatedAt + minutes * MINUTE_MS;
    const losing = result === 'LOSS';
    const cause = i % 2 === 0 ? 'NO_FOLLOW_THROUGH' : 'STOP_HUNT_REVERSAL';
    await world.close(
      created,
      losing
        ? outcomeOf(result, closedAt, {
            durationS: minutes * 60,
            exitReason: 'STOP',
            exitPrice: 4010.9,
            realizedRGross: -1,
            realizedRNet: -1.03,
            mfeR: 0.3,
            maeR: -1.02,
            tp1Hit: false,
            tp2Hit: false,
            isWin: false,
          })
        : outcomeOf(result, closedAt, { durationS: minutes * 60 }),
      losing ? review(cause) : null,
    );
  }

  // Open now: one that has not moved, and one that has reached TP1 and trails its stop.
  await world.createSignal({
    strategy: 'trend_pullback',
    side: 'BUY',
    generatedAt: now - 22 * MINUTE_MS,
    qualityScore: 82,
  });
  const half = await world.createSignal({
    strategy: 'sweep_reversal',
    side: 'BUY',
    generatedAt: now - 75 * MINUTE_MS,
    qualityScore: 76,
  });
  await world.setState(
    half.id,
    {
      status: 'TP1_HIT',
      stopLossCurrent: 4017.37,
      tp1HitAt: now - 40 * MINUTE_MS,
      mfeR: 1.1,
      maeR: -0.1,
    },
    now - 40 * MINUTE_MS,
  );
}

/** The calendar, the headlines and the moves: what the News screen and the news state read. */
async function news(api: PgApi, now: number): Promise<void> {
  const event = async (
    at: number,
    name: string,
    importance: 'low' | 'medium' | 'high',
    values: { actual?: number; forecast?: number; previous?: number; unit?: string } = {},
  ) =>
    api.admin.query(
      `INSERT INTO macro_events
         (id, source, source_event_id, scheduled_at, currency, name, importance, unit, actual, forecast, previous, raw)
       VALUES ($1, 'biquote', $2, $3, 'USD', $4, $5, $6, $7, $8, $9, '{"timeMode":"exact"}'::jsonb)`,
      [
        randomUUID(),
        `live-${name}-${String(at)}`,
        new Date(at),
        name,
        importance,
        values.unit ?? null,
        values.actual ?? null,
        values.forecast ?? null,
        values.previous ?? null,
      ],
    );
  await event(now - 6 * DAY, 'US CPI m/m', 'high', {
    actual: 0.4,
    forecast: 0.3,
    previous: 0.2,
    unit: '%',
  });
  await event(now - 5 * DAY, 'US Core PCE Price Index m/m', 'high', {
    actual: 0.2,
    forecast: 0.2,
    previous: 0.3,
    unit: '%',
  });
  await event(now - 4 * DAY, 'US Nonfarm Payrolls', 'high', {
    actual: 142,
    forecast: 160,
    previous: 150,
    unit: 'K',
  });
  await event(now - 3 * DAY, 'US Unemployment Claims', 'medium', {
    actual: 221,
    forecast: 225,
    previous: 224,
    unit: 'K',
  });
  await event(now - 2 * DAY, 'US ISM Services PMI', 'medium', {
    actual: 52.1,
    forecast: 51.5,
    previous: 51.8,
  });
  await event(now - 20 * HOUR, 'FOMC Meeting Minutes', 'high');
  await event(now + 3 * HOUR, 'US Retail Sales m/m', 'high', {
    forecast: 0.3,
    previous: 0.2,
    unit: '%',
  });
  await event(now + DAY, 'US Unemployment Claims', 'medium', {
    forecast: 223,
    previous: 221,
    unit: 'K',
  });
  await event(now + 2 * DAY, 'FOMC Rate Decision', 'high', {
    forecast: 4.25,
    previous: 4.25,
    unit: '%',
  });

  await api.admin.query(
    `INSERT INTO news_sources (key, name, tier, enabled, last_ok_at, last_error) VALUES
       ('reuters', 'Reuters', 1, true, $1, NULL),
       ('fxstreet', 'FXStreet', 2, true, $1, NULL),
       ('kitco', 'Kitco', 2, true, $2, 'HTTP 503 from the feed')`,
    [new Date(now - 40_000), new Date(now - 3 * HOUR)],
  );
  const stories: [string, string, 'LOW' | 'MEDIUM' | 'HIGH', string[], number][] = [
    [
      'Fed officials signal patience on cuts as inflation proves sticky',
      'reuters',
      'HIGH',
      ['FED_RATES', 'INFLATION_JOBS'],
      35,
    ],
    [
      'Dollar slips against majors ahead of retail sales data',
      'fxstreet',
      'MEDIUM',
      ['USD_DOLLAR'],
      80,
    ],
    [
      'Gold holds above support as traders weigh rate outlook',
      'kitco',
      'MEDIUM',
      ['GOLD_DIRECT', 'FED_RATES'],
      130,
    ],
    [
      'Central banks added to gold reserves again in the third quarter',
      'reuters',
      'MEDIUM',
      ['CENTRAL_BANK_GOLD'],
      300,
    ],
    [
      'Tensions rise in the region, safe-haven demand firms',
      'reuters',
      'HIGH',
      ['GEOPOLITICS_WAR', 'RISK_OFF'],
      520,
    ],
    ['Trump says new tariffs are coming next month', 'fxstreet', 'HIGH', ['TRUMP_POLICY'], 760],
    ['US yields edge lower after a soft auction', 'fxstreet', 'LOW', ['USD_DOLLAR'], 1000],
    ['Gold ETF holdings rise for a fourth day', 'kitco', 'LOW', ['GOLD_DIRECT'], 1500],
  ];
  for (const [index, [title, source, impact, topics, minutesAgo]] of stories.entries()) {
    await api.admin.query(
      `INSERT INTO news_items
         (id, source_key, url_hash, title, url, published_at, first_seen_at, topics, impact, impact_score, cluster_id, classifier_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, '1.0.0')`,
      [
        randomUUID(),
        source,
        `live-hash-${String(index)}`,
        title,
        `https://example.com/live-${String(index)}`,
        new Date(now - minutesAgo * MINUTE_MS - 60_000),
        new Date(now - minutesAgo * MINUTE_MS),
        topics,
        impact,
        impact === 'HIGH' ? 0.8 : impact === 'MEDIUM' ? 0.5 : 0.2,
        randomUUID(),
      ],
    );
  }
  const moves: [string, number, number, number][] = [
    ['SPIKE_UP', 95, 9.8, 2.8],
    ['SPIKE_DOWN', 300, 7.4, 2.1],
    ['SPIKE_UP', 1400, 11.2, 3.2],
  ];
  for (const [kind, minutesAgo, usd, atr] of moves) {
    await api.admin.query(
      `INSERT INTO market_events (kind, detected_at, window_s, move_usd, move_atr, spread, headlines)
       VALUES ($1, $2, 300, $3, $4, 0.35, $5::jsonb)`,
      [kind, new Date(now - minutesAgo * MINUTE_MS), usd, atr, JSON.stringify([])],
    );
  }
}

/** Health, incidents and the retention runs: what the System screen reads. */
async function system(api: PgApi, now: number): Promise<void> {
  await api.admin.query(
    `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ('backup', $1, '{}'::jsonb)
     ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
    [new Date(now - 7 * HOUR)],
  );
  for (const [started, finished] of [
    [now - 30 * HOUR, now - 30 * HOUR + MINUTE_MS],
    [now - 6 * HOUR, now - 6 * HOUR + 2 * MINUTE_MS],
  ] as const) {
    await api.admin.query(
      `INSERT INTO maintenance_runs (job, started_at, finished_at, rows_deleted) VALUES ('retention', $1, $2, 1200)`,
      [new Date(started), new Date(finished)],
    );
  }
  for (const [kind, from, to] of [
    ['STALE', now - 3 * DAY, now - 3 * DAY + 4 * MINUTE_MS],
    ['DISCONNECT', now - DAY, now - DAY + 12 * MINUTE_MS],
    ['STALE', now - 5 * HOUR, now - 5 * HOUR + 90_000],
  ] as const) {
    await api.admin.query(
      `INSERT INTO feed_incidents (kind, started_at, ended_at, details) VALUES ($1, $2, $3, '{"reason":"no tick"}'::jsonb)`,
      [kind, new Date(from), new Date(to)],
    );
  }
}

/** The data of a few months of a system that has been running: everything the screens show, as the worker's own store writes it. */
export async function seedLive(api: PgApi, world: SeedWorld, now: number): Promise<void> {
  await tickPartitions(api, now);
  await candles(api, now);
  await signals(world, now);
  await news(api, now);
  await system(api, now);
}

/**
 * The worker's side of the stack while a browser looks at it: a tick every second (a walk around the price), the
 * heartbeat that says the feed is live, the state of the decision loop, and the heartbeats of the other jobs.
 */
export function startWorkerSimulator(api: PgApi, options: { warm?: boolean } = {}): () => void {
  const warm = options.warm ?? true;
  let price = LIVE_PRICE;
  let seed = 11;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const timers: NodeJS.Timeout[] = [];
  const guarded = (work: () => Promise<unknown>) => () => {
    void work().catch(() => undefined);
  };

  timers.push(
    setInterval(
      guarded(() => {
        price = Math.max(4000, Math.min(4035, price + (random() - 0.5) * 0.9));
        const bid = Math.round(price * 1000) / 1000;
        const at = new Date(api.clock.now);
        return api.admin.query(
          'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, $2, $3, $4)',
          [at, 'XAUUSD', bid, Math.round((bid + 0.168) * 1000) / 1000],
        );
      }),
      1000,
    ),
  );
  const beat = guarded(async () => {
    const now = new Date(api.clock.now);
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ('worker', $1, $2::jsonb)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata`,
      [
        now,
        JSON.stringify({
          mode: 'record-only',
          provider: 'biquote',
          recorder: { feedState: 'LIVE' },
        }),
      ],
    );
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ('calendar', $1, '{}'::jsonb)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [now],
    );
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('engineState', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          evaluatedAt: api.clock.now,
          regime: 'TREND_UP',
          volBucket: 'NORMAL',
          session: 'LONDON',
          newsState: 'CLEAR',
          atr5: 4.3,
          warmup: warm
            ? { ready: true, progressPct: 100, missingTimeframes: [] }
            : { ready: false, progressPct: 12, missingTimeframes: ['5m', '15m', '1h'] },
          waitReasons: warm
            ? [
                { code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' },
                { code: 'COOLDOWN_OK', label: 'Cooldown: the last signal was 22 minutes ago' },
              ]
            : [],
        }),
      ],
    );
  });
  beat();
  timers.push(setInterval(beat, 8000));
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
