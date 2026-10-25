import { describe, expect, it, vi } from 'vitest';

import type { TickInput } from '@vmgs/core';

import type { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { FILL_AT, Rig, SECOND, buyDraft, sellDraft, tickAt } from './test-data';

// 120 random feeds restarted three ways: quick alone, slower when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A feed after the fill: the closing price of a BUY (the bid) as a random walk, with silences of every length now and then. */
function feedOf(seed: number): TickInput[] {
  const random = mulberry32(seed);
  const pick = (min: number, max: number) => min + random() * (max - min);
  const steady = random() < 0.6;
  const count = Math.floor(pick(15, 110));
  const ticks: TickInput[] = [];
  let seconds = 0;
  let price = 4017.37;
  for (let i = 0; i < count; i += 1) {
    const kind = random();
    seconds += Math.round(
      steady || kind < 0.9 ? pick(1, 8) : kind < 0.97 ? pick(11, 40) : pick(70, 200),
    );
    price += (random() - 0.5) * (random() < 0.08 ? 14 : 2.4);
    ticks.push(tickAt(seconds, Math.round(price * 1000) / 1000));
  }
  return ticks;
}

interface Snapshot {
  readonly signals: readonly unknown[];
}

/** Everything the database holds about the signals, without the wall-clock times of the writes. */
function snapshotOf(store: MemoryLifecycleStore): Snapshot {
  const ids = [...store.signals.values()].sort((a, b) => a.seq - b.seq).map((record) => record.id);
  return {
    signals: ids.map((id) => ({
      id: store.signals.get(id)?.seq,
      state: store.states.get(id) ?? null,
      events: store
        .eventsOf(id)
        .map((event) => (event.type.startsWith('AUTOPSY') ? { ...event, at: 0 } : event)),
      outcome: store.outcomes.get(id) ?? null,
      review: store.autopsies.get(id)?.review ?? null,
      outbox: [...store.outbox.values()]
        .filter((row) => row.signalId === id)
        .map((row) => ({
          key: `${row.eventKey.replace(id, 'ID')}|${row.channel}`,
          kind: row.kind,
          payload: JSON.parse(JSON.stringify(row.payload).replaceAll(id, 'ID')) as unknown,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    })),
  };
}

async function prepared(): Promise<Rig> {
  const rig = new Rig();
  await rig.start();
  await rig.create(buyDraft());
  await rig.create(sellDraft());
  return rig;
}

async function uninterrupted(feed: readonly TickInput[]): Promise<Snapshot> {
  const rig = await prepared();
  for (const tick of feed) await rig.deliver([tick]);
  await rig.restart();
  const snapshot = snapshotOf(rig.store);
  await rig.stop();
  return snapshot;
}

describe('a worker that is killed and restarted mid-trade', () => {
  it('ends in the same place as one that never stopped, wherever and however it stopped', async () => {
    let closed = 0;
    let open = 0;
    let cancelled = 0;
    let withReview = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const feed = feedOf(seed);
      const expected = await uninterrupted(feed);
      const random = mulberry32(seed + 1000);
      for (let round = 0; round < 3; round += 1) {
        const stopAt = Math.floor(random() * (feed.length + 1));
        // some ticks were stored but not followed when the process died
        const lost = round === 0 ? 0 : Math.floor(random() * 4);
        const rig = await prepared();
        for (const tick of feed.slice(0, stopAt)) await rig.deliver([tick]);
        for (const tick of feed.slice(stopAt, stopAt + lost)) rig.store.ticks.push(tick);
        await rig.restart();
        for (const tick of feed.slice(stopAt + lost)) await rig.deliver([tick]);
        await rig.restart();
        const label = `seed ${String(seed)} stop ${String(stopAt)} lost ${String(lost)}`;
        expect(snapshotOf(rig.store), label).toEqual(expected);
        await rig.stop();
      }
      for (const entry of expected.signals as {
        outcome: { outcome: { result: string } } | null;
        review: unknown;
      }[]) {
        if (entry.outcome === null) open += 1;
        else if (entry.outcome.outcome.result === 'CANCELLED') cancelled += 1;
        else closed += 1;
        if (entry.review !== null) withReview += 1;
      }
    }
    // the feeds reach every ending
    expect(closed).toBeGreaterThan(60);
    expect(open).toBeGreaterThan(20);
    expect(cancelled).toBeGreaterThan(10);
    expect(withReview).toBeGreaterThan(10);
  });

  it('a signal that was written in the middle of the feed is caught up the same way after a restart', async () => {
    const feed = feedOf(7);
    const early = feed.filter((tick) => tick.ts < FILL_AT + 40 * SECOND);
    const rig = new Rig();
    await rig.start();
    for (const tick of early) await rig.deliver([tick]);
    await rig.create(buyDraft());
    await rig.restart();
    const once = snapshotOf(rig.store);
    await rig.restart();
    expect(snapshotOf(rig.store)).toEqual(once);
    await rig.stop();
  });
});
