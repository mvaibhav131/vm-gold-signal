import { z } from 'zod';

import { marketSnapshotSchema, type MarketSnapshot, type WaitReason } from '@vmgs/contracts';
import {
  ENGINE_STATE_MAX_AGE_MS,
  GATE_DEFAULTS,
  REGIMES,
  TIMEFRAMES,
  gateLabel,
  isPaused,
  openRiskR,
  sessionAt,
  type FeedState,
  type Regime,
  type StoredEngine,
  type Timeframe,
} from '@vmgs/core';
import { WORKER_ALIVE_MAX_AGE_MS } from '@vmgs/db';

import { ProblemError } from '../http/problem';
import type { MarketFacts } from './reader';

/** The tick may be this much older than the gate allows before the snapshot calls the feed stale by itself (the heartbeat is every 15 s). */
const FEED_GRACE_MS = 5000;

/** The timeframes the decision loop needs candles of: all of them are missing until it has said anything. */
const ENGINE_TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '1h'];

/** What the decision loop stores (`EngineStateDoc`), read for what the snapshot needs and nothing else. */
const engineStateDocSchema = z.object({
  evaluatedAt: z.number(),
  regime: z.enum(REGIMES).nullable(),
  warmup: z.object({
    ready: z.boolean(),
    progressPct: z.number().min(0).max(100),
    missingTimeframes: z.array(z.enum(TIMEFRAMES)),
  }),
  waitReasons: z.array(z.object({ code: z.string().min(1), label: z.string().min(1) })),
});
type EngineStateDoc = z.infer<typeof engineStateDocSchema>;

const engineDocSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('RUNNING') }),
  z.object({
    status: z.literal('PAUSED'),
    pausedSince: z.iso.datetime(),
    pausedUntil: z.iso.datetime().nullable(),
  }),
]);

/** The stored document, or null when it is missing or not what the loop writes: nothing is better than something wrong. */
function engineStateOf(value: unknown): EngineStateDoc | null {
  const parsed = engineStateDocSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The owner's pause as the worker reads it (`app_settings.engine`); a document that cannot be read is no pause. */
export function storedEngineOf(value: unknown): StoredEngine {
  const parsed = engineDocSchema.safeParse(value);
  if (!parsed.success || parsed.data.status === 'RUNNING') return { status: 'RUNNING' };
  return {
    status: 'PAUSED',
    since: Date.parse(parsed.data.pausedSince),
    until: parsed.data.pausedUntil === null ? null : Date.parse(parsed.data.pausedUntil),
  };
}

/**
 * The state of the feed as the screens show it. The feed monitor's own state comes with the worker's heartbeat; a
 * worker that has not been heard from is no feed at all, and a tick that is older than the gate allows is stale
 * whatever the last heartbeat said. `WARMING_UP` is the worker's, not the feed's: it shows while the engine lacks
 * candles, and while the worker has not yet told what the feed does.
 */
export function feedStateOf(
  facts: MarketFacts,
  ageMs: number,
  now: number,
  warmedUp: boolean,
): FeedState {
  const { heartbeatAt, feedState } = facts.worker;
  if (heartbeatAt === null || now - heartbeatAt > WORKER_ALIVE_MAX_AGE_MS) return 'DISCONNECTED';
  if (feedState === 'LIVE') {
    if (ageMs > GATE_DEFAULTS.maxTickAgeSec * 1000 + FEED_GRACE_MS) return 'STALE';
    return warmedUp ? 'LIVE' : 'WARMING_UP';
  }
  if (feedState === 'STALE' || feedState === 'DISCONNECTED' || feedState === 'MARKET_CLOSED') {
    return feedState;
  }
  return 'WARMING_UP';
}

/** Why no signal can come while the feed is not live, in the words of the gates (the labels the decision loop stores). */
function feedWaitReason(state: FeedState, ageMs: number): WaitReason | null {
  if (state !== 'DISCONNECTED' && state !== 'STALE' && state !== 'MARKET_CLOSED') return null;
  return {
    code: 'DATA_FRESH',
    label: gateLabel({ code: 'DATA_FRESH', passed: false, reason: state, value: ageMs / 1000 }),
  };
}

/**
 * `GET /market/snapshot` from what the database holds. A tick that is not there is a 503 `no_quote`: the contract has no
 * way to say "no price", and a made-up one is the worst thing a trading screen can show.
 */
export function snapshotOf(facts: MarketFacts, now: number): MarketSnapshot {
  const { quote } = facts;
  if (quote === null) {
    throw new ProblemError(503, 'no_quote', 'No quote has been recorded yet.');
  }
  const ageMs = Math.max(0, now - quote.sourceAt);
  const bidMilli = Math.round(quote.bid * 1000);
  const askMilli = Math.round(quote.ask * 1000);

  const state = engineStateOf(facts.engineStateDoc);
  // what was decided long ago says nothing about now; how far the warm-up got never expires (candles only accumulate)
  const fresh = state !== null && now - state.evaluatedAt <= ENGINE_STATE_MAX_AGE_MS;
  const warmup = state?.warmup ?? {
    ready: false,
    progressPct: 0,
    missingTimeframes: [...ENGINE_TIMEFRAMES],
  };
  const feedState = feedStateOf(facts, ageMs, now, warmup.ready);

  const stored = storedEngineOf(facts.engineDoc);
  // a signal after TP1 has its stop at break-even or better: it risks nothing more (what the engine counts too)
  const openRisk = openRiskR(facts.openStatuses);

  // the reasons of the last decision, except a stale feed that has since recovered (it is looked at again now)
  const waitReasons: WaitReason[] = fresh
    ? state.waitReasons.filter((reason) => !(feedState === 'LIVE' && reason.code === 'DATA_FRESH'))
    : [];
  if (!warmup.ready && !waitReasons.some((reason) => reason.code === 'WARMUP_OK')) {
    waitReasons.unshift({
      code: 'WARMUP_OK',
      label: gateLabel({ code: 'WARMUP_OK', passed: false, missing: warmup.missingTimeframes }),
    });
  }
  const feedReason = feedWaitReason(feedState, ageMs);
  if (feedReason !== null && !waitReasons.some((reason) => reason.code === 'DATA_FRESH')) {
    waitReasons.unshift(feedReason);
  }

  const regime: Regime = fresh && state.regime !== null ? state.regime : 'UNCERTAIN';
  const pausedSince = isPaused(stored, now) ? new Date(stored.since).toISOString() : null;
  return marketSnapshotSchema.parse({
    symbol: 'XAUUSD',
    bid: quote.bid,
    ask: quote.ask,
    mid: Math.floor((bidMilli + askMilli + 1) / 2) / 1000,
    spread: (askMilli - bidMilli) / 1000,
    sourceAt: new Date(quote.sourceAt).toISOString(),
    receivedAt: new Date(quote.receivedAt).toISOString(),
    ageMs,
    feedState,
    session: sessionAt(now),
    regime,
    mode: facts.worker.provider === 'replay' ? 'SIMULATED' : 'LIVE',
    engine: {
      status: pausedSince === null ? 'RUNNING' : 'PAUSED',
      ...(pausedSince === null ? {} : { pausedSince }),
      openCount: facts.openStatuses.length,
      openRiskR: openRisk,
      warmup: {
        ready: warmup.ready,
        progressPct: warmup.progressPct,
        missingTimeframes: warmup.ready ? [] : warmup.missingTimeframes,
      },
      waitReasons,
      evaluatedAt: new Date(state?.evaluatedAt ?? now).toISOString(),
    },
  });
}
