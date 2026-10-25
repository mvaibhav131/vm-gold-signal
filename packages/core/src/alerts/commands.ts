/** The commands the bot understands (04_API_and_Notifications section 4, "Commands"), plus `/start` and `/link`. */
export const BOT_COMMANDS = [
  'start',
  'help',
  'status',
  'open',
  'last',
  'today',
  'month',
  'pause',
  'resume',
  'link',
] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

export type ParsedCommand =
  | { readonly command: BotCommand; readonly args: readonly string[] }
  /** A command the bot does not have (`/foo`). */
  | { readonly command: 'unknown'; readonly name: string; readonly args: readonly string[] };

/** The longest pause the API accepts, in minutes (a week). */
export const MAX_PAUSE_MINUTES = 10_080;

const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)/;

/**
 * Reads a message as a command. Text that is not a command is null (the bot does not talk back to
 * ordinary text). `/status@MyBot` is for this bot only when `botUsername` matches (or is not known);
 * a command addressed to another bot is null. Names are case-insensitive, the arguments are the
 * words that follow.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const trimmed = text.trim();
  const match = COMMAND.exec(trimmed);
  if (match === null) return null;
  const [whole = '', rawName = '', addressedTo = ''] = match;
  if (
    addressedTo !== '' &&
    botUsername !== undefined &&
    addressedTo.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }
  const name = rawName.toLowerCase();
  const args = trimmed
    .slice(whole.length)
    .split(/\s+/)
    .filter((word) => word !== '');
  const known = BOT_COMMANDS.find((command) => command === name);
  return known === undefined ? { command: 'unknown', name, args } : { command: known, args };
}

export type PauseArgument =
  { readonly ok: true; readonly minutes: number | null } | { readonly ok: false };

/** `/pause` has no end (until `/resume`), `/pause 30` ends after 30 minutes; anything else is refused. */
export function pauseArgument(args: readonly string[]): PauseArgument {
  if (args.length === 0) return { ok: true, minutes: null };
  const [first] = args;
  if (args.length > 1 || first === undefined || !/^\d{1,5}$/.test(first)) return { ok: false };
  const minutes = Number(first);
  return minutes >= 1 && minutes <= MAX_PAUSE_MINUTES ? { ok: true, minutes } : { ok: false };
}

/** The code of `/link`: 8 digits, with or without the dash in the middle (`1234-5678` or `12345678`). Null when it is not one. */
export function linkCodeOf(args: readonly string[]): string | null {
  if (args.length !== 1) return null;
  const match = /^(\d{4})-?(\d{4})$/.exec(args[0] ?? '');
  return match === null ? null : `${match[1] ?? ''}${match[2] ?? ''}`;
}
