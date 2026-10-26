import { authStoreContract } from '../auth/storeContract';
import { MemoryAuthStore } from './memoryAuthStore';

authStoreContract('MemoryAuthStore', () => {
  const store = new MemoryAuthStore();
  return Promise.resolve({
    store,
    audit: () =>
      Promise.resolve(
        store.auditLog.map((event) => ({
          type: event.type,
          success: event.success,
          ipHash: event.ipHash,
          at: event.at,
          detail: event.detail ?? {},
        })),
      ),
    attemptCount: () => Promise.resolve(store.attempts.length),
  });
});
