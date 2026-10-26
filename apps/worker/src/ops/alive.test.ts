import { describe, expect, it } from 'vitest';

import { WORKER_ALIVE_MAX_AGE_MS, WORKER_HEARTBEAT, isFresh, workerHeartbeatAgeMs } from './alive';

function reader(rows: { heartbeat_at: Date }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  return {
    seen,
    db: {
      query: (text: string, values: unknown[]) => {
        seen.push({ text, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('workerHeartbeatAgeMs', () => {
  it('is the age of the heartbeat of the worker', async () => {
    const { db, seen } = reader([{ heartbeat_at: new Date(1_000_000) }]);
    expect(await workerHeartbeatAgeMs(db, 1_012_000)).toBe(12_000);
    expect(seen[0]?.values).toEqual([WORKER_HEARTBEAT]);
  });

  it('is null when there is no heartbeat yet', async () => {
    expect(await workerHeartbeatAgeMs(reader([]).db, 1_000)).toBeNull();
  });
});

describe('isFresh', () => {
  it('allows three missed beats of 15 seconds, not more', () => {
    expect(isFresh(0)).toBe(true);
    expect(isFresh(WORKER_ALIVE_MAX_AGE_MS)).toBe(true);
    expect(isFresh(WORKER_ALIVE_MAX_AGE_MS + 1)).toBe(false);
  });

  it('is false without a heartbeat, and true for a heartbeat a little in the future', () => {
    expect(isFresh(null)).toBe(false);
    expect(isFresh(-500)).toBe(true);
  });

  it('takes the limit as an argument', () => {
    expect(isFresh(50_000, 60_000)).toBe(true);
    expect(isFresh(70_000, 60_000)).toBe(false);
  });
});
