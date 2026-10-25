import type { EngineFacts } from './replies';

/** The owner's pause as `app_settings.engine` holds it, with the times in milliseconds. */
export interface PausedEngine {
  readonly status: 'PAUSED';
  readonly since: number;
  readonly until: number | null;
}
export type StoredEngine = { readonly status: 'RUNNING' } | PausedEngine;

/** True while the engine is paused. A timed pause that has run out is over: nobody has to press resume. */
export function isPaused(state: StoredEngine, now: number): state is PausedEngine {
  return state.status === 'PAUSED' && (state.until === null || now < state.until);
}

/** The engine as `/status` shows it. */
export function engineFactsOf(state: StoredEngine, now: number): EngineFacts {
  return isPaused(state, now)
    ? { status: 'PAUSED', since: state.since, until: state.until }
    : { status: 'RUNNING' };
}

/** The state after `/pause` (`minutes` null: until `/resume`). */
export function pausedAt(now: number, minutes: number | null): PausedEngine {
  return {
    status: 'PAUSED',
    since: now,
    until: minutes === null ? null : now + minutes * 60_000,
  };
}

/** The pause is told once, under its own name: the time it began (`engine:<pauseId>:paused`). */
export const pauseIdOf = (since: number): string => String(since);
