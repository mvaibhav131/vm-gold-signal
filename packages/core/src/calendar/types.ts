import type { MacroImportance } from '../domain';
import type { MacroEventInput } from '../context/macro';

/** How exact the time of an event is: `exact`, `tentative` (a time is given but may move) or `date` (only the day is known). */
export type TimeMode = 'exact' | 'tentative' | 'date';

/** A calendar event as the worker stores it and the engine and the alerts read it (times in epoch milliseconds). */
export interface CalendarRecord extends MacroEventInput {
  /** The provider's id of this release (`macro_events.source_event_id`). */
  readonly sourceEventId: string;
  /** The provider's id of the series (CPI m/m), shared by every release of the indicator. */
  readonly seriesId: string | null;
  readonly countryCode: string | null;
  readonly name: string;
  readonly unit: string | null;
  readonly multiplier: string | null;
  readonly digits: number | null;
  readonly actual: number | null;
  readonly forecast: number | null;
  readonly previous: number | null;
  readonly revisedPrevious: number | null;
  readonly timeMode: TimeMode;
  readonly firstSeenAt: number;
  /** When the released value was first seen; null while there is none. */
  readonly actualFirstSeenAt: number | null;
}

const RANK: Readonly<Record<MacroImportance, number>> = { low: 0, medium: 1, high: 2 };

/** `importance` is at least `minimum` (`low` < `medium` < `high`). */
export const importanceAtLeast = (importance: MacroImportance, minimum: MacroImportance): boolean =>
  RANK[importance] >= RANK[minimum];
