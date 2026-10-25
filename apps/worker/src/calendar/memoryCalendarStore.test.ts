import { calendarStoreContract } from './storeContract';
import { MemoryCalendarStore } from '../testing/memoryCalendarStore';

calendarStoreContract('memory', () => {
  const store = new MemoryCalendarStore();
  return Promise.resolve({
    harness: { store, surprise: (id) => Promise.resolve(store.surprises.get(id) ?? null) },
    done: () => Promise.resolve(),
  });
});
