import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { newsStoreContract } from './storeContract';

newsStoreContract('memory', () => {
  const store = new MemoryNewsStore();
  return Promise.resolve({
    harness: {
      store,
      setEnabled: (key, enabled) => {
        store.setEnabled(key, enabled);
        return Promise.resolve();
      },
      addHighEvent: (at) => {
        store.highEventTimes.push(at);
        return Promise.resolve();
      },
    },
    done: () => Promise.resolve(),
  });
});
