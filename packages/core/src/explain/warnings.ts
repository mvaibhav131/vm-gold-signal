import type { FlagDetail, FlagResult } from '../gates/flags';
import { fixedText, priceText, spanText } from './format';
import type { ExplanationWarning } from './types';

/** Names that the flags themselves do not carry. */
export interface WarningContext {
  /** The name of the event of an open news window (`CPI m/m`). */
  readonly eventName?: string | null;
  /** The public number of the open signals, by id (`#S-0042`). */
  readonly openLabels?: Readonly<Record<string, string>>;
}

const numberOf = (detail: FlagDetail, key: string): number | null => {
  const value = detail[key];
  return typeof value === 'number' ? value : null;
};

const textOf = (detail: FlagDetail, key: string): string | null => {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
};

const listOf = (detail: FlagDetail, key: string): readonly string[] => {
  const value = detail[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
};

const minutesText = (minutes: number): string => spanText(Math.abs(minutes) * 60_000);

function newsWindowText(detail: FlagDetail, context: WarningContext): string {
  const name = context.eventName ?? 'a high-impact event';
  const minutes = numberOf(detail, 'minutesToEvent');
  const when =
    minutes === null
      ? ''
      : minutes >= 0
        ? ` in ${minutesText(minutes)}`
        : ` was ${minutesText(minutes)} ago`;
  const settling = detail.settling === true ? ' (volatility is still settling)' : '';
  return `News window: ${name}${when}${settling}`;
}

function newsShockText(detail: FlagDetail): string {
  const parts: string[] = [];
  const atr = numberOf(detail, 'atrRatio');
  const spread = numberOf(detail, 'spreadRatio');
  if (atr !== null) parts.push(`ATR ${fixedText(atr, 1)} x its 24 h median`);
  if (spread !== null) parts.push(`spread ${fixedText(spread, 1)} x its 24 h median`);
  return `News shock: ${parts.length > 0 ? parts.join(', ') : 'volatility jumped'}`;
}

function nearLevelText(detail: FlagDetail): string {
  const kind = (textOf(detail, 'kind') ?? 'level').toLowerCase().replace(/_/g, ' ');
  const price = numberOf(detail, 'price');
  const distance = numberOf(detail, 'distanceAtr');
  return `Near a major ${kind}${price === null ? '' : ` at ${priceText(price)}`}${
    distance === null ? '' : ` (${fixedText(distance, 1)} x ATR away)`
  }`;
}

function opposesText(detail: FlagDetail, context: WarningContext): string {
  const ids = listOf(detail, 'signalIds');
  const labels = ids.flatMap((id) => {
    const label = context.openLabels?.[id];
    return label === undefined ? [] : [label];
  });
  if (labels.length > 0)
    return `Opposes open signal${labels.length === 1 ? '' : 's'} ${labels.join(', ')}`;
  return `Opposes ${String(ids.length)} open signal${ids.length === 1 ? '' : 's'}`;
}

/** The sentence for one advisory flag that is present (02_Signal_Engine section 6), from its numbers. */
export function warningText(result: FlagResult, context: WarningContext = {}): string {
  const { detail } = result;
  switch (result.flag) {
    case 'NEWS_WINDOW':
      return newsWindowText(detail, context);
    case 'NEWS_SHOCK':
      return newsShockText(detail);
    case 'HEADLINE_RECENT': {
      const ago = numberOf(detail, 'minutesAgo');
      return ago === null
        ? 'A HIGH-impact headline was published recently'
        : `A HIGH-impact headline was published ${minutesText(ago)} ago`;
    }
    case 'ROLLOVER':
      return 'Rollover hours: liquidity is thin and spreads can be wide';
    case 'OFF_HOURS':
      return textOf(detail, 'session') === 'ASIA'
        ? 'Off hours: the Asia session is quiet'
        : 'Off hours: London and New York are about to close';
    case 'NEAR_LEVEL':
      return nearLevelText(detail);
    case 'OPPOSES_OPEN':
      return opposesText(detail, context);
    case 'UNVALIDATED_STRATEGY':
      return 'FORWARD-TEST: this strategy is not validated yet (paper signal)';
    case 'NEWS_UNKNOWN':
      return 'News calendar unavailable: news risk is not known';
  }
}

/** The warnings of a signal: one line for each flag that is present, in the order of the flags. */
export function warningsOf(
  flags: readonly FlagResult[],
  context: WarningContext = {},
): ExplanationWarning[] {
  return flags
    .filter((result) => result.present)
    .map((result) => ({ code: result.flag, text: warningText(result, context) }));
}
