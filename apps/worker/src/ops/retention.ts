/**
 * Which nightly backups to keep (06 section 4): the newest of each of the last 7 days, 4 weeks and 3 months
 * that have a backup. "Last" counts days that have a backup, not calendar days, so a long outage never makes
 * the plan delete the only backups there are. Names that are not ours are never touched.
 */

export interface RetentionPolicy {
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 3 };

const NAME = /^vmgs-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.age$/;

/** `vmgs-20261026T020000Z.dump.age`: the UTC time, so the names sort as text. */
export function backupName(at: number): string {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `vmgs-${stamp}Z.dump.age`;
}

/** The time a name stands for (UTC ms), or null when the name is not one of ours or not a real time. */
export function backupTime(name: string): number | null {
  const match = NAME.exec(name);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  return backupName(at) === name ? at : null;
}

const DAY_MS = 86_400_000;

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function monthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** ISO 8601 week of a UTC instant, as `YYYY-Www` (a week belongs to the year of its Thursday). */
function weekKey(at: number): string {
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday is 0
  const thursday = new Date(day + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

export interface BackupPlan {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
  /** Names that are not backups of ours: left alone. */
  readonly ignored: readonly string[];
}

interface Backup {
  readonly name: string;
  readonly at: number;
}

/** The newest backup of each of the `count` most recent groups that have one (a group is what `keyOf` says). */
function newestOfRecentGroups(
  newestFirst: readonly Backup[],
  keyOf: (at: number) => string,
  count: number,
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const backup of newestFirst) {
    const key = keyOf(backup.at);
    if (seen.has(key)) continue;
    if (seen.size === count) break;
    seen.add(key);
    kept.push(backup.name);
  }
  return kept;
}

export function planBackups(
  names: readonly string[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): BackupPlan {
  const backups: Backup[] = [];
  const ignored: string[] = [];
  for (const name of new Set(names)) {
    const at = backupTime(name);
    if (at === null) ignored.push(name);
    else backups.push({ name, at });
  }
  backups.sort((a, b) => b.at - a.at);

  const keep = new Set([
    ...newestOfRecentGroups(backups, dayKey, policy.daily),
    ...newestOfRecentGroups(backups, weekKey, policy.weekly),
    ...newestOfRecentGroups(backups, monthKey, policy.monthly),
  ]);
  return {
    keep: backups.filter((b) => keep.has(b.name)).map((b) => b.name),
    remove: backups.filter((b) => !keep.has(b.name)).map((b) => b.name),
    ignored,
  };
}
