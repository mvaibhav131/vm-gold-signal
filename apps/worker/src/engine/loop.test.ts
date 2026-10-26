import { defaultStrategyConfig } from '@vmgs/config';
import {
  MarketTracker,
  RISK_DEFAULTS,
  mergeByClose,
  type StrategySpec,
  type StructureCandle,
} from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  BASE,
  EVIDENCE,
  FEED_OK,
  FIVE_MS,
  mirrored,
  pullbackSpec,
  seriesOf,
} from '../../../../packages/core/src/engine/test-data';
import {
  QUARTER_MS,
  fromCloses,
  hourlyUp,
  random,
  walk,
} from '../../../../packages/core/src/regime/test-data';
import type { Scenario } from '../../../../packages/core/src/strategies/trendPullback/test-data';
import { SignalCreator } from '../lifecycle/signals';
import { MemoryEngineStore } from '../testing/memoryEngineStore';
import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { DecisionLoop, type CalendarContext, type FeedView } from './loop';

const TRIGGER = 53;
const CLOSE = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
const PRICE = BASE.five[TRIGGER]?.c ?? 0;
const STEPS = mergeByClose(seriesOf(BASE));

interface Options {
  specs?: readonly StrategySpec[];
  feed?: FeedView;
  calendar?: CalendarContext;
  now?: number;
  scene?: Scenario;
  creator?: { create(input: unknown): Promise<{ status: 'CREATED' | 'DUPLICATE' }> };
}

/** A creator that only keeps the drafts it is given, for the tests of what the loop hands over. */
function stubCreator() {
  const drafts: { dataLatencyMs: number; sourceAt: string }[] = [];
  return {
    drafts,
    creator: {
      create: (input: unknown) => {
        drafts.push(input as (typeof drafts)[number]);
        return Promise.resolve({ status: 'CREATED' as const });
      },
    },
  };
}

async function rig(options: Options = {}) {
  const steps = options.scene === undefined ? STEPS : mergeByClose(seriesOf(options.scene));
  const price = options.scene === undefined ? PRICE : (options.scene.five[TRIGGER]?.c ?? 0);
  const store = new MemoryEngineStore();
  const lifecycle = new MemoryLifecycleStore();
  const clock = { now: options.now ?? CLOSE + 2_000 };
  const real = new SignalCreator({ store: lifecycle, now: () => clock.now });
  await real.registerStrategies([defaultStrategyConfig('trend_pullback')]);
  const queued = { count: 0 };
  const logs: string[] = [];
  const detailsLog: string[] = [];
  const state = {
    feed: options.feed ?? { facts: FEED_OK, clockSkewMs: 900 },
    calendar: options.calendar ?? { available: true, events: [], names: {} },
  };
  const loop = new DecisionLoop({
    specs: options.specs ?? [pullbackSpec()],
    store,
    creator: (options.creator ?? real) as never,
    calendar: () => Promise.resolve(state.calendar),
    news: {
      read: () =>
        Promise.resolve({ feed: 'AVAILABLE' as const, headlines: [], lastHighHeadlineAt: null }),
    },
    feed: () => state.feed,
    onQueued: () => {
      queued.count += 1;
    },
    now: () => clock.now,
    pollMs: 5,
    log: (level, message, details) => {
      logs.push(`${level}: ${message}`);
      if (details !== undefined) detailsLog.push(JSON.stringify(details));
    },
  });
  for (const step of steps) if (step.closeTime < CLOSE) store.add(step.tf, step.candle);
  return {
    store,
    lifecycle,
    clock,
    queued,
    logs,
    detailsLog,
    loop,
    state,
    /** The candles that close with candle 53, and the quote of the instant they closed. */
    arrive(quote = true) {
      for (const step of steps) if (step.closeTime === CLOSE) store.add(step.tf, step.candle);
      if (quote)
        store.quotes.push({ t: CLOSE, rxAt: CLOSE + 1_000, bid: price - 0.06, ask: price + 0.06 });
    },
    signals: () => [...lifecycle.signals.values()],
  };
}

describe('DecisionLoop: the warm-up', () => {
  it('replays the stored candles into the engine without deciding anything', async () => {
    const { loop, signals, store } = await rig();
    await loop.warmUp();
    expect(loop.counts['5m']).toBe(TRIGGER);
    expect(loop.stats.decisions).toBe(0);
    expect(signals()).toHaveLength(0);
    expect(store.states).toHaveLength(0);
  });

  it('does not decide a candle that was already in the table at the start, whatever the clock says', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(1);
    // a second process starts on the same table: the candle is history for it
    const second = await rig();
    second.arrive();
    await second.loop.warmUp();
    expect(await second.loop.runOnce()).toBe(0);
    expect(second.loop.counts['5m']).toBe(TRIGGER + 1);
  });
});

describe('DecisionLoop: a decision', () => {
  it('writes a signal when a 5m candle has closed and its first quote is stored, and tells the sender', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    const written = await r.loop.runOnce();
    expect(written).toBe(1);
    expect(r.loop.stats).toEqual({
      decisions: 1,
      signals: 1,
      rejections: 0,
      duplicates: 0,
      skipped: 0,
    });
    expect(r.queued.count).toBe(1);
    const [signal] = r.signals();
    expect(signal).toMatchObject({ side: 'BUY', mode: 'LIVE' });
    expect(signal?.strategy.strategyKey).toBe('trend_pullback');
  });

  it('feeds the candles of the three timeframes that closed together, the 1h and the 15m before the 5m', async () => {
    const r = await rig();
    await r.loop.warmUp();
    const before = r.loop.counts;
    r.arrive();
    await r.loop.runOnce();
    expect(r.loop.counts).toEqual({
      '5m': before['5m'] + 1,
      '15m': before['15m'] + 1,
      '1h': before['1h'] + 1,
    });
  });

  it('asks the table only for what it has not fed, one cursor for the three timeframes', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    await r.loop.runOnce();
    const last = r.store.cursors.at(-1);
    expect(last).toEqual({
      '5m': BASE.five[TRIGGER]?.openTime,
      '15m': BASE.quarter.at(-1)?.openTime,
      '1h': BASE.hourly.at(-1)?.openTime,
    });
  });

  it('writes nothing until the first quote after the close is stored, and decides when it is', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive(false);
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.stats.decisions).toBe(0);
    r.clock.now = CLOSE + 4_000;
    r.store.quotes.push({
      t: CLOSE + 1_000,
      rxAt: CLOSE + 2_000,
      bid: PRICE - 0.06,
      ask: PRICE + 0.06,
    });
    expect(await r.loop.runOnce()).toBe(1);
  });

  it('gives up on a candle that no quote followed within five minutes, and says so', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive(false);
    await r.loop.runOnce();
    r.clock.now = CLOSE + 5 * 60_000 + 1_000;
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.stats.skipped).toBe(1);
    expect(r.logs).toContain('error: no quote after the close of a 5m candle: no decision');
    // the quote that comes later belongs to a candle that is no longer decided
    r.store.quotes.push({ t: CLOSE + 400_000, rxAt: CLOSE + 401_000, bid: 1, ask: 1.1 });
    expect(await r.loop.runOnce()).toBe(0);
  });

  it('does not decide on a quote that came after the entry could be valid', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive(false);
    r.store.quotes.push({
      t: CLOSE + 200_000,
      rxAt: CLOSE + 201_000,
      bid: PRICE - 0.06,
      ask: PRICE + 0.06,
    });
    r.clock.now = CLOSE + 202_000;
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.stats).toMatchObject({ decisions: 0, skipped: 1 });
  });

  it('decides a candle once: a second look at the same table writes nothing', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(1);
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.signals()).toHaveLength(1);
    expect(r.loop.stats.decisions).toBe(1);
  });

  it('does not decide candles of the past that it catches up with (a worker that was down)', async () => {
    const r = await rig({ now: CLOSE + 3_600_000 });
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.stats.decisions).toBe(0);
    expect(r.loop.counts['5m']).toBe(TRIGGER + 1);
  });

  it('asks for the evidence of each setup and puts it into the signal', async () => {
    const r = await rig();
    r.store.evidenceOf = () => ({ ...EVIDENCE, n: 12, wins: 7 });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.store.evidenceAsked).toEqual([
      {
        strategyKey: 'trend_pullback',
        strategyVersion: '0.1.0',
        side: 'BUY',
        session: 'OVERLAP',
        regime: 'UNCERTAIN',
        volBucket: 'NORMAL',
      },
    ]);
    expect(r.signals()[0]?.explanation.evidence).toMatchObject({ n: 12, wins: 7 });
  });

  it("hands the open signals and the owner's switches to the decision", async () => {
    const r = await rig();
    r.store.open = [{ id: 'sell-1', side: 'SELL', riskR: 1, label: '#S-0041' }];
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    const warnings = r.signals()[0]?.explanation.warnings.map((w) => w.code);
    expect(warnings).toContain('OPPOSES_OPEN');
    expect(r.signals()[0]?.explanation.open).toEqual({ count: 1, riskR: 1 });
  });

  it('warns that the news is unknown when the calendar is down', async () => {
    const r = await rig({ calendar: { available: false, events: [], names: {} } });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.signals()[0]?.explanation.warnings.map((w) => w.code)).toContain('NEWS_UNKNOWN');
  });

  it('takes the data gates from the live feed: a silent feed blocks, and the reason is recorded', async () => {
    const r = await rig({
      feed: { facts: { ...FEED_OK, tickAgeMs: 40_000 }, clockSkewMs: 900 },
    });
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.signals()).toHaveLength(0);
    expect(r.store.rejections).toHaveLength(1);
    expect(r.store.rejections[0]).toMatchObject({
      at: CLOSE,
      rejection: { strategyKey: 'trend_pullback', side: 'BUY', codes: ['DATA_FRESH'] },
    });
    expect(r.loop.stats).toMatchObject({ decisions: 1, rejections: 1, signals: 0 });
  });
});

describe('DecisionLoop: the state of the engine', () => {
  it('stores the regime, the session and the warm-up after every decision, with or without a setup', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    const [saved] = r.store.states;
    expect(saved?.at).toBe(CLOSE + 2_000);
    expect(saved?.state).toMatchObject({
      evaluatedAt: CLOSE,
      regime: null,
      session: 'OVERLAP',
      newsState: 'CLEAR',
      warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
      waitReasons: [],
    });
  });

  it('puts the reason of a failed market gate in the wait reasons', async () => {
    const r = await rig({
      feed: { facts: { ...FEED_OK, connected: false }, clockSkewMs: 900 },
    });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.store.states[0]?.state.waitReasons).toEqual([
      { code: 'DATA_FRESH', label: 'Feed disconnected: new signals are blocked' },
    ]);
  });

  it('says it is still warming up while the strategy needs more candles', async () => {
    const spec = pullbackSpec();
    const slow = {
      ...spec,
      gates: { ...spec.gates, warmupCandles: { '5m': 100, '15m': 1, '1h': 1 } },
    };
    const r = await rig({ specs: [slow] });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    const state = r.store.states[0]?.state;
    expect(state?.warmup.ready).toBe(false);
    expect(state?.warmup.missingTimeframes).toEqual(['5m']);
    expect(state?.waitReasons[0]?.code).toBe('WARMUP_OK');
  });
});

describe('DecisionLoop: the pause', () => {
  it('keeps the candles and the state but writes no signal and no rejection while the owner has paused', async () => {
    const r = await rig();
    r.store.controlsNow = { paused: true, modes: {}, disabled: [] };
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.signals()).toHaveLength(0);
    expect(r.store.rejections).toHaveLength(0);
    expect(r.store.states).toHaveLength(1);
    expect(r.loop.counts['5m']).toBe(TRIGGER + 1);
  });

  it('says nothing for a strategy the owner has switched off, and goes on for the others', async () => {
    const off = await rig();
    off.store.controlsNow = { paused: false, modes: {}, disabled: ['trend_pullback'] };
    await off.loop.warmUp();
    off.arrive();
    expect(await off.loop.runOnce()).toBe(0);
    expect(off.signals()).toHaveLength(0);
    expect(off.store.rejections).toHaveLength(0);
    expect(off.store.states).toHaveLength(1);
    expect(off.loop.counts['5m']).toBe(TRIGGER + 1);

    const other = await rig();
    other.store.controlsNow = { paused: false, modes: {}, disabled: ['sweep_reversal'] };
    await other.loop.warmUp();
    other.arrive();
    expect(await other.loop.runOnce()).toBe(1);
    expect(other.signals()).toHaveLength(1);
  });

  it('applies the switches of the owner: a news window that is set to block stops the signal', async () => {
    const calendar: CalendarContext = {
      available: true,
      events: [
        { id: 'cpi', scheduledAt: CLOSE + 30 * 60_000, importance: 'high', currency: 'USD' },
      ],
      names: { cpi: 'CPI m/m' },
    };
    const r = await rig({ calendar });
    r.store.controlsNow = { paused: false, modes: { newsWindow: 'block' }, disabled: [] };
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.store.rejections[0]?.rejection.codes).toEqual(['NEWS_WINDOW']);
  });
});

describe('DecisionLoop: what goes wrong', () => {
  it('counts a setup that already has a signal as a duplicate and goes on', async () => {
    const r = await rig({ creator: { create: () => Promise.resolve({ status: 'DUPLICATE' }) } });
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.stats).toMatchObject({ signals: 0, duplicates: 1 });
    expect(r.queued.count).toBe(0);
  });

  it('logs a signal that could not be written and does not stop', async () => {
    const r = await rig({
      creator: { create: () => Promise.reject(new Error('the draft breaks a rule')) },
    });
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.logs).toContain('error: a decision could not be written');
    expect(r.loop.stats.decisions).toBe(1);
  });

  it('logs a rejection that could not be written and goes on', async () => {
    const r = await rig({
      feed: { facts: { ...FEED_OK, tickAgeMs: 40_000 }, clockSkewMs: 900 },
    });
    r.store.failRejection = true;
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.logs).toContain('error: a decision could not be written');
    expect(r.loop.stats.rejections).toBe(0);
  });

  it('writes the signal even when the state of the engine cannot be saved', async () => {
    const r = await rig();
    r.store.saveState = () => Promise.reject(new Error('the database is slow'));
    await r.loop.warmUp();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(1);
    expect(r.logs).toContain('error: the engine state could not be saved');
  });

  it('keeps the candle for the next look when what the decision reads cannot be read, and decides it then', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.arrive();
    let failures = 1;
    const controls = r.store.controls.bind(r.store);
    r.store.controls = (now) =>
      failures-- > 0 ? Promise.reject(new Error('the database is down')) : controls(now);
    await expect(r.loop.runOnce()).rejects.toThrow('the database is down');
    expect(r.loop.stats.decisions).toBe(0);
    expect(await r.loop.runOnce()).toBe(1);
    expect(r.signals()).toHaveLength(1);
  });

  it('warms up by itself when it is asked to look before the start', async () => {
    const r = await rig();
    r.arrive();
    expect(await r.loop.runOnce()).toBe(0);
    expect(r.loop.counts['5m']).toBe(TRIGGER + 1);
  });
});

describe('DecisionLoop: the edges of its windows', () => {
  const FIVE_MIN = 5 * 60_000;
  const quote = (t: number) => ({ t, rxAt: t + 1, bid: PRICE - 0.06, ask: PRICE + 0.06 });

  it('still decides a candle that closed exactly five minutes ago, and not one that closed a millisecond earlier', async () => {
    const edge = await rig({ now: CLOSE + FIVE_MIN, creator: stubCreator().creator });
    await edge.loop.warmUp();
    edge.arrive();
    await edge.loop.runOnce();
    expect(edge.loop.stats.decisions).toBe(1);

    const late = await rig({ now: CLOSE + FIVE_MIN + 1, creator: stubCreator().creator });
    await late.loop.warmUp();
    late.arrive();
    await late.loop.runOnce();
    expect(late.loop.stats.decisions).toBe(0);
  });

  it('waits five minutes for a quote and gives up only after that', async () => {
    const r = await rig({ now: CLOSE + 1_000 });
    await r.loop.warmUp();
    r.arrive(false);
    await r.loop.runOnce();
    r.clock.now = CLOSE + FIVE_MIN;
    await r.loop.runOnce();
    expect(r.loop.stats.skipped).toBe(0);
    r.clock.now = CLOSE + FIVE_MIN + 1;
    await r.loop.runOnce();
    expect(r.loop.stats.skipped).toBe(1);
  });

  it('takes a first quote that comes exactly when the entry stops being valid, and not one a millisecond later', async () => {
    const valid = RISK_DEFAULTS.entryValidSec * 1_000;
    const on = await rig({ creator: stubCreator().creator });
    await on.loop.warmUp();
    on.arrive(false);
    on.store.quotes.push(quote(CLOSE + valid));
    on.clock.now = CLOSE + valid + 2;
    await on.loop.runOnce();
    expect(on.loop.stats).toMatchObject({ decisions: 1, skipped: 0 });

    const over = await rig({ creator: stubCreator().creator });
    await over.loop.warmUp();
    over.arrive(false);
    over.store.quotes.push(quote(CLOSE + valid + 1));
    over.clock.now = CLOSE + valid + 2;
    await over.loop.runOnce();
    expect(over.loop.stats).toMatchObject({ decisions: 0, skipped: 1 });
  });

  it('holds the entry to the shortest window of the strategies it runs', async () => {
    const quick = pullbackSpec({
      version: '0.2.0',
      risk: { ...RISK_DEFAULTS, entryValidSec: 60 },
    });
    const r = await rig({ specs: [pullbackSpec(), quick], creator: stubCreator().creator });
    await r.loop.warmUp();
    r.arrive(false);
    r.store.quotes.push(quote(CLOSE + 90_000));
    r.clock.now = CLOSE + 95_000;
    await r.loop.runOnce();
    expect(r.loop.stats).toMatchObject({ decisions: 0, skipped: 1 });
  });

  it('writes the age of the quote as the latency of the data, and never a negative one', async () => {
    const aged = stubCreator();
    const r = await rig({ creator: aged.creator });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(aged.drafts.map((draft) => draft.dataLatencyMs)).toEqual([2_000]);
    expect(aged.drafts.map((draft) => draft.sourceAt)).toEqual([new Date(CLOSE).toISOString()]);

    const ahead = stubCreator();
    const early = await rig({ now: CLOSE, creator: ahead.creator });
    await early.loop.warmUp();
    early.arrive(false);
    early.store.quotes.push(quote(CLOSE + 1_000));
    await early.loop.runOnce();
    expect(ahead.drafts.map((draft) => draft.dataLatencyMs)).toEqual([0]);
  });

  it('does not decide when only a 15m or 1h candle has arrived without the 5m candle that closes with it', async () => {
    const r = await rig();
    await r.loop.warmUp();
    for (const step of STEPS) {
      if (step.closeTime === CLOSE && step.tf !== '5m') r.store.add(step.tf, step.candle);
    }
    r.store.quotes.push(quote(CLOSE));
    await r.loop.runOnce();
    expect(r.loop.stats).toMatchObject({ decisions: 0, signals: 0, rejections: 0 });
  });

  it('goes on reading while a read comes back full', async () => {
    const r = await rig();
    await r.loop.warmUp();
    const last = BASE.five[TRIGGER - 1];
    if (last === undefined) throw new Error('no candle');
    for (let k = 1; k <= 2_005; k += 1) {
      r.store.add('5m', { ...last, openTime: last.openTime + k * FIVE_MS, spread: 0.25 });
    }
    await r.loop.runOnce();
    expect(r.loop.counts['5m']).toBe(TRIGGER + 2_005);
  });
});

describe('DecisionLoop: what it hands to the decision', () => {
  it('names the next event from the calendar it is given', async () => {
    const calendar = {
      available: true,
      events: [
        {
          id: 'cpi',
          scheduledAt: CLOSE + 30 * 60_000,
          importance: 'high' as const,
          currency: 'USD',
        },
      ],
      names: { cpi: 'CPI m/m' },
    };
    const r = await rig({ calendar });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.signals()[0]?.explanation.macro).toMatchObject({
      state: 'IN_WINDOW',
      next: { name: 'CPI m/m' },
    });
  });

  it('names the open signal it opposes by its label', async () => {
    const r = await rig();
    r.store.open = [{ id: 'sell-1', side: 'SELL', riskR: 1, label: '#S-0041' }];
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    const warning = r.signals()[0]?.explanation.warnings.find((w) => w.code === 'OPPOSES_OPEN');
    expect(warning?.text).toContain('#S-0041');
  });

  it('asks for the evidence of the side of a SELL, and writes the SELL', async () => {
    const r = await rig({ scene: mirrored() });
    await r.loop.warmUp();
    r.arrive();
    await r.loop.runOnce();
    expect(r.store.evidenceAsked.map((dims) => dims.side)).toEqual(['SELL']);
    expect(r.signals()[0]?.side).toBe('SELL');
  });
});

describe('DecisionLoop: the review context', () => {
  it('knows the regime at a past close and the changes of character of a trade', async () => {
    const r = await rig();
    await r.loop.warmUp();
    const context = r.loop.contextOf({ fillAt: CLOSE - 3_600_000 }, CLOSE - 300_000);
    expect(context.regimeAtClose).toBeNull();
    expect(Array.isArray(context.structureBreaks)).toBe(true);
  });

  describe('over a long market', () => {
    const wick = (n: number) => 0.1 + ((n * 7) % 5) * 0.08;
    const next = random(3);
    const withSpread = (candles: readonly StructureCandle[], from: number, ms: number) =>
      candles.map((candle, i) => ({ ...candle, openTime: from + i * ms, spread: 0.2 }));
    const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
    const series = {
      '1h': withSpread(hourlyUp(300), T0, 3_600_000),
      '15m': withSpread(
        fromCloses(
          walk(
            4000,
            Array.from({ length: 1_200 }, () => (next() - 0.5) * 3),
          ),
          QUARTER_MS,
          wick,
        ),
        T0,
        QUARTER_MS,
      ),
      '5m': withSpread(
        fromCloses(
          walk(
            4300,
            Array.from({ length: 4_500 }, () => next() - 0.5),
          ),
          FIVE_MS,
          wick,
        ),
        T0,
        FIVE_MS,
      ),
    };

    async function market() {
      const store = new MemoryEngineStore();
      for (const tf of ['5m', '15m', '1h'] as const) {
        for (const candle of series[tf]) store.add(tf, candle);
      }
      const loop = new DecisionLoop({
        specs: [pullbackSpec()],
        store,
        creator: stubCreator().creator as never,
        calendar: () => Promise.resolve({ available: true, events: [], names: {} }),
        news: {
          read: () =>
            Promise.resolve({
              feed: 'AVAILABLE' as const,
              headlines: [],
              lastHighHeadlineAt: null,
            }),
        },
        feed: () => ({ facts: FEED_OK, clockSkewMs: 0 }),
        history: { '5m': 5_000, '15m': 2_000, '1h': 900 },
      });
      await loop.warmUp();
      // the same market in a plain tracker: the regime at each 5m close, and every change of character
      const tracker = new MarketTracker();
      const seen: { at: number; regime: string | null }[] = [];
      for (const step of mergeByClose(series)) {
        tracker.push(step.tf, step.candle);
        if (step.tf === '5m') {
          seen.push({ at: step.closeTime, regime: tracker.regime.state?.regime ?? null });
        }
      }
      return { loop, tracker, seen };
    }

    it('gives the regime of the close of the trade, not that of its fill', async () => {
      const { loop, seen } = await market();
      const known = seen.filter((item) => item.regime !== null);
      const closed = known.at(-1);
      const filled = known.findLast((item) => item.regime !== closed?.regime);
      expect(closed?.regime).toBeDefined();
      expect(filled).toBeDefined();
      const context = loop.contextOf({ fillAt: filled?.at ?? 0 }, closed?.at ?? 0);
      expect(context.regimeAtClose).toBe(closed?.regime);
      expect(context.regimeAtClose).not.toBe(filled?.regime);
    }, 60_000);

    it('gives the changes of character after the fill and up to the close, and no earlier one', async () => {
      const { loop, tracker, seen } = await market();
      const all = tracker.changesOfCharacter(0, Number.MAX_SAFE_INTEGER);
      expect(all.length).toBeGreaterThan(6);
      const fillAt = all.at(-5)?.at ?? 0;
      const closedAt = seen.at(-1)?.at ?? 0;
      const expected = tracker.changesOfCharacter(fillAt, closedAt);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(all.length);
      expect(loop.contextOf({ fillAt }, closedAt).structureBreaks).toEqual(expected);
    }, 60_000);
  });
});

describe('DecisionLoop: running', () => {
  it('follows the table on its own loop, wakes at once when told, survives a failing store, and stops', async () => {
    const r = await rig();
    await r.loop.warmUp();
    r.loop.start();
    r.loop.start();
    r.arrive();
    r.loop.wake();
    await expect.poll(() => r.signals().length).toBe(1);
    await r.loop.stop();
    const looks = r.store.cursors.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.store.cursors.length).toBe(looks);
  });

  it('logs a look that fails and tries again', async () => {
    const r = await rig();
    await r.loop.warmUp();
    let failures = 1;
    const after = r.store.after.bind(r.store);
    r.store.after = (cursor, limit) =>
      failures-- > 0 ? Promise.reject(new Error('the database is down')) : after(cursor, limit);
    r.loop.start();
    await expect.poll(() => r.logs.length).toBeGreaterThan(0);
    r.arrive();
    await expect.poll(() => r.signals().length).toBe(1);
    await r.loop.stop();
    expect(r.logs).toContain('error: the decision loop could not finish a look');
  });
});
