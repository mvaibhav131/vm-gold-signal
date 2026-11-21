import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  RISK_KEY,
  changeRiskPrefs,
  parseRiskPrefs,
  serializeRiskPrefs,
  type RiskPrefs,
} from './riskPrefs';

/** What the owner chose when local storage cannot be written (private mode, full): it then lasts until the page closes. */
let memory: string | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(RISK_KEY);
  } catch {
    return null;
  }
}

function writeRaw(raw: string): void {
  try {
    window.localStorage.setItem(RISK_KEY, raw);
    memory = null;
  } catch {
    memory = raw;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === RISK_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The demo account of the position size, shared by every card and the detail page, kept in this browser. */
export function useRiskPrefs(): {
  readonly prefs: RiskPrefs;
  readonly change: (change: Partial<RiskPrefs>) => void;
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const prefs = useMemo(() => parseRiskPrefs(raw), [raw]);
  const change = useCallback((next: Partial<RiskPrefs>) => {
    writeRaw(serializeRiskPrefs(changeRiskPrefs(parseRiskPrefs(readRaw()), next)));
  }, []);
  return { prefs, change };
}
