import { NOTIFICATION_KINDS, type NotificationKind } from '@vmgs/core';

/** The kinds the owner can switch on or off. A test message is not one of them: it is sent when the owner asks. */
export type SelectableKind = Exclude<NotificationKind, 'TEST'>;

export const SELECTABLE_KINDS: readonly SelectableKind[] = NOTIFICATION_KINDS.filter(
  (kind): kind is SelectableKind => kind !== 'TEST',
);

export const KIND_LABELS: Readonly<Record<SelectableKind, string>> = {
  SIGNAL_NEW: 'New signal',
  SIGNAL_TP1: 'TP1 reached',
  SIGNAL_CLOSED: 'Signal closed',
  SIGNAL_CANCELLED: 'Signal cancelled',
  SIGNAL_REVIEW_FINAL: 'Final review of a loss',
  NEWS_UPCOMING: 'High-impact event coming',
  NEWS_RELEASED: 'Event released',
  NEWS_HEADLINE: 'High-impact headline',
  MARKET_MOVE: 'Sudden move of gold',
  SYSTEM_DEGRADED: 'System degraded',
  SYSTEM_RECOVERED: 'System recovered',
  ENGINE_PAUSED: 'Engine paused',
  STORAGE_WARNING: 'Storage warning',
  DAILY_DIGEST: 'Daily summary',
  MONTHLY_REPORT: 'Monthly report',
};

/** The kinds that are in `chosen`, in the order of the list (the settings keep them unique and in one order). */
export function orderedKinds(chosen: readonly string[]): SelectableKind[] {
  return SELECTABLE_KINDS.filter((kind) => chosen.includes(kind));
}

export const GATE_KEYS = ['newsWindow', 'rollover', 'offHours', 'nearLevel'] as const;
export type GateKey = (typeof GATE_KEYS)[number];

export const GATE_TEXT: Readonly<Record<GateKey, { label: string; description: string }>> = {
  newsWindow: {
    label: 'News window',
    description: 'A high-impact USD event is close: from 45 minutes before to 20 minutes after.',
  },
  rollover: {
    label: 'Rollover',
    description: 'The daily rollover, 21:45 to 23:15 UTC, when spreads are wide.',
  },
  offHours: {
    label: 'Off hours',
    description: 'The quiet hours between the sessions, when moves are thin.',
  },
  nearLevel: {
    label: 'Near a key level',
    description: 'Price is next to a previous high or low, a session level or a round number.',
  },
};
