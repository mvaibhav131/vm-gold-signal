import type { NotificationKind } from '../domain';
import { escapeHtml, renderHtml } from './markup';
import type { TelegramMessage } from './types';

export { escapeHtml };

/** Messages stay under this many characters (04_API_and_Notifications section 4, "Length"). */
export const TELEGRAM_SOFT_LIMIT = 3500;

/** What the Telegram Bot API accepts in one message. */
export const TELEGRAM_HARD_LIMIT = 4096;

/** One rendering of a message at a level of detail: its lines, and what was left out to get there. */
export interface Rendering {
  readonly lines: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * Renders at level 0 (everything) and, while the text is longer than `TELEGRAM_SOFT_LIMIT`, at the
 * next level, which leaves out more of the optional parts. Levels are written so that levels, stop,
 * targets and the evidence line are never among the parts that go. The length is that of the
 * escaped text, which is what Telegram counts. A message that is longer than the hard limit even at
 * the last level is refused.
 */
export function fitMessage(
  kind: NotificationKind,
  render: (level: number) => Rendering,
  lastLevel: number,
): TelegramMessage {
  let rendering = render(0);
  let level = 0;
  let text = renderHtml(rendering.lines.join('\n'));
  while (text.length > TELEGRAM_SOFT_LIMIT && level < lastLevel) {
    level += 1;
    rendering = render(level);
    text = renderHtml(rendering.lines.join('\n'));
  }
  if (text.length > TELEGRAM_HARD_LIMIT) {
    throw new RangeError(`${kind} is ${String(text.length)} characters: too long for Telegram`);
  }
  return { kind, text, level, dropped: rendering.dropped };
}
