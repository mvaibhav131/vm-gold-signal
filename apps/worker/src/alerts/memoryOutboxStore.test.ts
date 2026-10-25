import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { outboxStoreContract, type OutboxHarness } from './outboxContract';

outboxStoreContract('in memory', () => {
  const store = new MemoryOutboxStore();
  const harness: OutboxHarness = {
    store,
    entry: (eventKey, channel) => Promise.resolve(store.entry(eventKey, channel)),
    addSubscription: (record) => {
      store.addSubscription(record);
      return Promise.resolve();
    },
    lastOk: (endpoint) => Promise.resolve(store.lastOk(endpoint)),
  };
  return Promise.resolve({ harness, done: () => Promise.resolve() });
});
