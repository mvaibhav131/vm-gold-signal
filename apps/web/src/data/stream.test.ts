import { QueryClient } from '@tanstack/react-query';
import type { MarketSnapshot, OpenSignalsResponse } from '@vmgs/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createMockClient } from '../mocks/mockClient';
import { KEYS } from './queries';
import { applyStreamEvent } from './stream';
import { memoryStorage } from '../test-utils';

async function seeded() {
  const api = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    scenario: 'two-open',
  });
  const queryClient = new QueryClient();
  const open = await api.getOpenSignals();
  queryClient.setQueryData(KEYS.openSignals, open);
  queryClient.setQueryData(KEYS.snapshot, await api.getSnapshot());
  return { api, queryClient, open };
}

describe('applyStreamEvent', () => {
  it('stores the newest quote', async () => {
    const { queryClient } = await seeded();
    const data = { bid: 4017.1, ask: 4017.3, spread: 0.2, ageMs: 400, feedState: 'LIVE' } as const;
    applyStreamEvent(queryClient, { event: 'quote', data });
    expect(queryClient.getQueryData(KEYS.quote)).toEqual(data);
  });

  it('patches the live R, status and stop of one open signal and leaves the others alone', async () => {
    const { queryClient, open } = await seeded();
    const target = open.items[1];
    const other = open.items[0];
    applyStreamEvent(queryClient, {
      event: 'signal_update',
      data: { id: target?.signal.id ?? '', status: 'TP1_HIT', unrealisedR: 1.1, stop: 4017.37 },
    });
    const after = queryClient.getQueryData<OpenSignalsResponse>(KEYS.openSignals);
    expect(after?.items[1]?.live).toMatchObject({
      status: 'TP1_HIT',
      unrealisedR: 1.1,
      stopLossCurrent: 4017.37,
    });
    expect(after?.items[0]).toEqual(other);
  });

  it('reloads the open signals when a signal closes or a new one arrives', async () => {
    const { queryClient } = await seeded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    applyStreamEvent(queryClient, {
      event: 'signal_update',
      data: {
        id: '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10',
        status: 'CLOSED',
        unrealisedR: 1,
        stop: 1,
      },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.openSignals });
    // the numbers of the Analytics screen change when a signal closes
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.analytics });
    invalidate.mockClear();
    applyStreamEvent(queryClient, {
      event: 'signal',
      data: { id: '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10' },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.openSignals });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.analytics });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.recentSignals });
    // the history list and the open pages of a signal follow too
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.signalHistory });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.signalDetail });
  });

  it('updates the engine state and reloads the snapshot when the owner pauses', async () => {
    const { queryClient } = await seeded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    applyStreamEvent(queryClient, {
      event: 'engine',
      data: {
        status: 'PAUSED',
        waitReasons: [{ code: 'PAUSED', label: 'Paused by you' }],
        regime: 'RANGE',
        session: 'ASIA',
      },
    });
    const snapshot = queryClient.getQueryData<MarketSnapshot>(KEYS.snapshot);
    expect(snapshot).toMatchObject({ regime: 'RANGE', session: 'ASIA' });
    expect(snapshot?.engine.status).toBe('PAUSED');
    expect(snapshot?.engine.waitReasons).toEqual([{ code: 'PAUSED', label: 'Paused by you' }]);
    // pausedSince is not in the event, so the snapshot is reloaded.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEYS.snapshot });
  });

  it('does not reload the snapshot for an engine event that changes no status', async () => {
    const { queryClient } = await seeded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    applyStreamEvent(queryClient, {
      event: 'engine',
      data: { status: 'RUNNING', waitReasons: [], regime: 'TREND_UP', session: 'LONDON' },
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('reloads everything on resync', async () => {
    const { queryClient } = await seeded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    applyStreamEvent(queryClient, { event: 'resync', data: {} });
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('ignores health events and does nothing without cached data', () => {
    const queryClient = new QueryClient();
    applyStreamEvent(queryClient, { event: 'health', data: { feed: 'OK' } });
    applyStreamEvent(queryClient, {
      event: 'signal_update',
      data: {
        id: '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10',
        status: 'ACTIVE',
        unrealisedR: 0.1,
        stop: 1,
      },
    });
    expect(queryClient.getQueryData(KEYS.openSignals)).toBeUndefined();
  });
});
