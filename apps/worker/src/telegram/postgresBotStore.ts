import { engineStateSchema } from '@vmgs/contracts';
import {
  ENGINE_STATE_MAX_AGE_MS,
  REGIMES,
  STRATEGY_KEYS,
  TRADED_SYMBOL,
  calendarAvailable,
  isRetiredStrategy,
  type PeriodRow,
  type Regime,
  type StoredEngine,
  type TimeWindow,
} from '@vmgs/core';
import type { Pool } from 'pg';

import { CALENDAR_HEARTBEAT } from '../calendar/postgresStore';
import { ENGINE_STATE_KEY } from '../engine/postgresStore';
import type { BotStore, OpenSignalRow, StatusFacts } from './botStore';
import type { PendingLink } from './link';

type Num = string | number;

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid number: ${String(value)}`);
  return result;
};
const numOrNull = (value: Num | null): number | null => (value === null ? null : num(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const LAST_KINDS = ['SIGNAL_CLOSED', 'SIGNAL_CANCELLED', 'SIGNAL_REVIEW_FINAL'];

/**
 * The regime and the wait reasons of the engine state that the decision loop stored, when it is recent. What is
 * stored is read defensively: a value that is not what the loop writes shows nothing rather than something wrong.
 */
function freshEngineState(
  value: unknown,
  now: number,
): { regime: Regime | null; waitReasons: string[] } {
  const none = { regime: null, waitReasons: [] };
  if (!isRecord(value)) return none;
  const { evaluatedAt, regime, waitReasons } = value;
  if (typeof evaluatedAt !== 'number' || now - evaluatedAt > ENGINE_STATE_MAX_AGE_MS) return none;
  return {
    regime:
      typeof regime === 'string' && (REGIMES as readonly string[]).includes(regime)
        ? (regime as Regime)
        : null,
    waitReasons: Array.isArray(waitReasons)
      ? (waitReasons as unknown[]).flatMap((item) =>
          isRecord(item) && typeof item.label === 'string' ? [item.label] : [],
        )
      : [],
  };
}

/**
 * The bot's facts from PostgreSQL. The link and the owner's pause live in `app_settings`
 * (`telegramChat`, `telegramLink`, `engine`), which the worker role may read, insert and update.
 */
export class PostgresBotStore implements BotStore {
  constructor(
    private readonly pool: Pool,
    private readonly tradedSymbol: string = TRADED_SYMBOL,
  ) {}

  private async setting(key: string): Promise<unknown> {
    const { rows } = await this.pool.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  private async put(
    executor: Pick<Pool, 'query'>,
    key: string,
    value: unknown,
    at: number,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), new Date(at)],
    );
  }

  async linkedChat(): Promise<number | null> {
    const value = await this.setting('telegramChat');
    return isRecord(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id)
      ? value.id
      : null;
  }

  async pendingLink(): Promise<PendingLink | null> {
    const value = await this.setting('telegramLink');
    if (
      !isRecord(value) ||
      typeof value.hash !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      typeof value.attempts !== 'number'
    ) {
      return null;
    }
    return { hash: value.hash, expiresAt: value.expiresAt, attempts: value.attempts };
  }

  async setPendingLink(link: PendingLink | null): Promise<void> {
    await this.put(this.pool, 'telegramLink', link, Date.now());
  }

  async linkChat(chatId: number, at: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.put(
        client,
        'telegramChat',
        { id: chatId, linkedAt: new Date(at).toISOString() },
        at,
      );
      await this.put(client, 'telegramLink', null, at);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async engine(): Promise<StoredEngine> {
    const value = await this.setting('engine');
    if (value === null) return { status: 'RUNNING' };
    const state = engineStateSchema.parse(value);
    return state.status === 'RUNNING'
      ? { status: 'RUNNING' }
      : {
          status: 'PAUSED',
          since: Date.parse(state.pausedSince),
          until: state.pausedUntil === null ? null : Date.parse(state.pausedUntil),
        };
  }

  async saveEngine(state: StoredEngine, at: number): Promise<void> {
    const value =
      state.status === 'RUNNING'
        ? { status: 'RUNNING' }
        : {
            status: 'PAUSED',
            pausedSince: new Date(state.since).toISOString(),
            pausedUntil: state.until === null ? null : new Date(state.until).toISOString(),
          };
    await this.put(this.pool, 'engine', engineStateSchema.parse(value), at);
  }

  async status(now: number): Promise<StatusFacts> {
    const [open, next, strategies, calendar, engine] = await Promise.all([
      this.pool.query<{ status: 'ACTIVE' | 'TP1_HIT' }>(
        "SELECT status FROM signal_state WHERE status IN ('ACTIVE', 'TP1_HIT')",
      ),
      this.pool.query<{ name: string; scheduled_at: Date }>(
        `SELECT name, scheduled_at FROM macro_events
          WHERE importance = 'high' AND scheduled_at > $1
          ORDER BY scheduled_at LIMIT 1`,
        [new Date(now)],
      ),
      this.pool.query<{
        strategy_key: StatusFacts['strategies'][number]['key'];
        version: string;
        status: StatusFacts['strategies'][number]['status'];
      }>(
        `SELECT DISTINCT ON (strategy_key) strategy_key, version, status
           FROM strategy_versions ORDER BY strategy_key, created_at DESC`,
      ),
      this.pool.query<{ heartbeat_at: Date }>(
        'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1',
        [CALENDAR_HEARTBEAT],
      ),
      this.setting(ENGINE_STATE_KEY),
    ]);
    const first = next.rows[0];
    const state = freshEngineState(engine, now);
    return {
      nextHigh: first === undefined ? null : { name: first.name, at: first.scheduled_at.getTime() },
      calendarAvailable: calendarAvailable(calendar.rows[0]?.heartbeat_at.getTime() ?? null, now),
      openStatuses: open.rows.map((row) => row.status),
      regime: state.regime,
      waitReasons: state.waitReasons,
      strategies: strategies.rows
        .filter((row) => !isRetiredStrategy(row.strategy_key))
        .map((row) => ({ key: row.strategy_key, version: row.version, status: row.status }))
        .sort((a, b) => STRATEGY_KEYS.indexOf(a.key) - STRATEGY_KEYS.indexOf(b.key)),
    };
  }

  async open(): Promise<OpenSignalRow[]> {
    const { rows } = await this.pool.query<{
      seq: Num;
      side: OpenSignalRow['side'];
      strategy_key: OpenSignalRow['strategyKey'];
      exit_profile: OpenSignalRow['exitProfile'];
      status: OpenSignalRow['status'];
      entry: Num;
      stop_loss_current: Num;
      tp1: Num;
      tp2: Num | null;
      risk_distance: Num;
      time_stop_at: Date;
    }>(
      `SELECT s.seq, s.side, sv.strategy_key, s.exit_profile, st.status, s.entry,
              st.stop_loss_current, s.tp1, s.tp2, s.risk_distance, s.time_stop_at
         FROM signal_state st
         JOIN signals s ON s.id = st.signal_id
         JOIN strategy_versions sv ON sv.id = s.strategy_version_id
        WHERE st.status IN ('ACTIVE', 'TP1_HIT')
        ORDER BY s.seq`,
    );
    return rows.map((row) => ({
      seq: num(row.seq),
      side: row.side,
      strategyKey: row.strategy_key,
      exitProfile: row.exit_profile,
      status: row.status,
      entry: num(row.entry),
      stop: num(row.stop_loss_current),
      tp1: num(row.tp1),
      tp2: numOrNull(row.tp2),
      riskDistance: num(row.risk_distance),
      timeStopAt: row.time_stop_at.getTime(),
    }));
  }

  async quote(now: number, maxAgeMs: number): Promise<{ bid: number; ask: number } | null> {
    const { rows } = await this.pool.query<{ bid: Num; ask: Num }>(
      'SELECT bid, ask FROM ticks WHERE symbol = $1 AND ts >= $2 ORDER BY ts DESC LIMIT 1',
      [this.tradedSymbol, new Date(now - maxAgeMs)],
    );
    const row = rows[0];
    return row === undefined ? null : { bid: num(row.bid), ask: num(row.ask) };
  }

  async lastClosedTexts(): Promise<string[]> {
    const { rows } = await this.pool.query<{ text: string }>(
      `SELECT payload->>'text' AS text
         FROM notification_outbox
        WHERE channel = 'telegram' AND kind = ANY($1::text[])
          AND signal_id = (
            SELECT signal_id FROM notification_outbox
             WHERE channel = 'telegram' AND kind = ANY($1::text[]) AND signal_id IS NOT NULL
             ORDER BY created_at DESC LIMIT 1)
        ORDER BY created_at, id`,
      [LAST_KINDS],
    );
    return rows.map((row) => row.text);
  }

  async periodRows(window: TimeWindow): Promise<PeriodRow[]> {
    const { rows } = await this.pool.query<{
      seq: Num;
      side: PeriodRow['side'];
      strategy_key: PeriodRow['strategyKey'];
      generated_at: Date;
      result: PeriodRow['result'];
      counts_in_stats: boolean | null;
      realized_r_net: Num | null;
      duration_s: number | null;
      tp1_hit: boolean | null;
      tp2_hit: boolean | null;
      closed_at: Date | null;
      primary_cause: PeriodRow['primaryCause'];
    }>(
      `SELECT s.seq, s.side, sv.strategy_key, s.generated_at, o.result, o.counts_in_stats,
              o.realized_r_net, o.duration_s, o.tp1_hit, o.tp2_hit, o.closed_at, a.primary_cause
         FROM signals s
         JOIN strategy_versions sv ON sv.id = s.strategy_version_id
         LEFT JOIN signal_outcomes o ON o.signal_id = s.id
         LEFT JOIN signal_autopsies a ON a.signal_id = s.id
        WHERE s.generated_at >= $1 AND s.generated_at < $2 AND s.mode <> 'BACKTEST'
        ORDER BY s.seq`,
      [new Date(window.from), new Date(window.until)],
    );
    return rows.map((row) => ({
      seq: num(row.seq),
      side: row.side,
      strategyKey: row.strategy_key,
      generatedAt: row.generated_at.getTime(),
      result: row.result,
      countsInStats: row.counts_in_stats ?? false,
      realizedRNet: numOrNull(row.realized_r_net),
      durationS: row.duration_s ?? 0,
      tp1Hit: row.tp1_hit ?? false,
      tp2Hit: row.tp2_hit ?? false,
      closedAt: (row.closed_at ?? row.generated_at).getTime(),
      primaryCause: row.primary_cause,
    }));
  }
}
