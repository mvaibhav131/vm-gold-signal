import type { MacroEvent, NewsStateResponse } from '@vmgs/contracts';

/** The news window of a high-impact event (02_Signal_Engine section 17): 45 minutes before and 20 minutes after. */
export const NEWS_WINDOW_BEFORE_MIN = 45;
export const NEWS_WINDOW_AFTER_MIN = 20;

const MINUTE_MS = 60_000;

export interface NewsWindow {
  readonly event: MacroEvent;
  readonly fromMs: number;
  readonly toMs: number;
}

export function newsWindowOf(event: MacroEvent): NewsWindow {
  const at = Date.parse(event.scheduledAt);
  return {
    event,
    fromMs: at - NEWS_WINDOW_BEFORE_MIN * MINUTE_MS,
    toMs: at + NEWS_WINDOW_AFTER_MIN * MINUTE_MS,
  };
}

/** The window that contains `nowMs`, of the next event or of the one that was just released; null when none does. */
export function activeNewsWindow(state: NewsStateResponse, nowMs: number): NewsWindow | null {
  for (const event of [state.next, state.last]) {
    if (event === null) continue;
    const window = newsWindowOf(event);
    if (nowMs >= window.fromMs && nowMs <= window.toMs) return window;
  }
  return null;
}
