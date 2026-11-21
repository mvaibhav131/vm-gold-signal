import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  SIGNALS_KEY,
  parseVisibility,
  serializeVisibility,
  setShow,
  toggleHidden,
  type SignalVisibility,
} from './chart/signalVisibility';

/** What the owner chose when local storage cannot be written (private mode, full): it then lasts until the page closes. */
let memory: string | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(SIGNALS_KEY);
  } catch {
    return null;
  }
}

function writeRaw(raw: string): void {
  try {
    window.localStorage.setItem(SIGNALS_KEY, raw);
    memory = null;
  } catch {
    memory = raw;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // another tab of the same browser changed it
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIGNALS_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The visibility of the signals on the chart, shared by the chart and by the cards of the signals (they are in different parts of
 * the page): one reads it, the other changes it, and both follow.
 */
export function useSignalVisibility(): {
  readonly visibility: SignalVisibility;
  readonly setShowAll: (show: boolean) => void;
  readonly toggleSignal: (seq: number) => void;
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const visibility = useMemo(() => parseVisibility(raw), [raw]);
  const setShowAll = useCallback((show: boolean) => {
    writeRaw(serializeVisibility(setShow(parseVisibility(readRaw()), show)));
  }, []);
  const toggleSignal = useCallback((seq: number) => {
    writeRaw(serializeVisibility(toggleHidden(parseVisibility(readRaw()), seq)));
  }, []);
  return { visibility, setShowAll, toggleSignal };
}
