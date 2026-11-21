/**
 * Which open signals the chart draws. The signals are drawn on their own (their levels as lines, their entry as an arrow), and the
 * owner can switch them all off, or hide one. The choice stays in this browser (a signal is a record of the system: it is never
 * removed, only not drawn).
 */
export interface SignalVisibility {
  /** False hides every signal on the chart. */
  readonly show: boolean;
  /** The numbers of the signals (`S-0042` is 42) hidden one by one. */
  readonly hidden: readonly number[];
}

export const SIGNALS_KEY = 'vmgs.chart.signals.v1';
export const DEFAULT_VISIBILITY: SignalVisibility = { show: true, hidden: [] };
/** A hidden number that is never used again is a few bytes; this only stops the list from growing for ever. */
export const MAX_HIDDEN = 200;

export function parseVisibility(raw: string | null | undefined): SignalVisibility {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_VISIBILITY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_VISIBILITY;
  }
  if (typeof data !== 'object' || data === null) return DEFAULT_VISIBILITY;
  const { show, hidden } = data as Record<string, unknown>;
  const list = Array.isArray(hidden)
    ? [...new Set(hidden.filter((value): value is number => Number.isInteger(value)))].slice(
        -MAX_HIDDEN,
      )
    : [];
  return { show: show !== false, hidden: list };
}

export function serializeVisibility(visibility: SignalVisibility): string {
  return JSON.stringify(visibility);
}

export function setShow(visibility: SignalVisibility, show: boolean): SignalVisibility {
  return { ...visibility, show };
}

/** The signal hidden if it was drawn, drawn again if it was hidden. */
export function toggleHidden(visibility: SignalVisibility, seq: number): SignalVisibility {
  const hidden = visibility.hidden.includes(seq)
    ? visibility.hidden.filter((value) => value !== seq)
    : [...visibility.hidden, seq].slice(-MAX_HIDDEN);
  return { ...visibility, hidden };
}

/** Is this signal drawn on the chart? */
export function isDrawn(visibility: SignalVisibility, seq: number): boolean {
  return visibility.show && !visibility.hidden.includes(seq);
}
