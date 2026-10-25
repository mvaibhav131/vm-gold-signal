import type { HighImpactSeen } from '@vmgs/core';
import { MemoryLifecycleStore } from '../testing/memoryLifecycleStore';
import { lifecycleStoreContract, type StoreHarness } from './storeContract';

lifecycleStoreContract('in memory', () => {
  const store = new MemoryLifecycleStore();
  const stories = new Map<string, HighImpactSeen>();
  const harness: StoreHarness = {
    store,
    events: (id) => Promise.resolve(store.eventsOf(id, true)),
    outbox: () =>
      Promise.resolve(
        [...store.outbox.values()].map((row) => ({ ...row, payload: { ...row.payload } })),
      ),
    state: (id) => Promise.resolve(store.states.get(id) ?? null),
    outcome: (id) => {
      const stored = store.outcomes.get(id);
      return Promise.resolve(
        stored === undefined ? null : { outcome: stored.outcome, meta: { ...stored.meta } },
      );
    },
    autopsy: (id) => Promise.resolve(store.autopsies.get(id) ?? null),
    addTicks: (ticks) => {
      store.ticks.push(...ticks);
      return Promise.resolve();
    },
    addCandles: (candles) => {
      store.candles.push(...candles);
      return Promise.resolve();
    },
    addMacroEvent: (name, at, importance) => {
      if (importance === 'high') store.highImpactItems.push({ kind: 'EVENT', name, at });
      return Promise.resolve();
    },
    addHeadline: (title, at, impact, cluster) => {
      if (impact !== 'HIGH') return Promise.resolve();
      const seen = stories.get(cluster);
      if (seen === undefined || at < seen.at) {
        if (seen !== undefined) {
          store.highImpactItems.splice(store.highImpactItems.indexOf(seen), 1);
        }
        const item: HighImpactSeen = { kind: 'HEADLINE', name: title, at };
        stories.set(cluster, item);
        store.highImpactItems.push(item);
      }
      return Promise.resolve();
    },
  };
  return Promise.resolve({ harness, done: () => Promise.resolve() });
});
