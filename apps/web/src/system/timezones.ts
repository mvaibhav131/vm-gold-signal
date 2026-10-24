/** A short list of the zones that matter to the owner, shown first. */
const COMMON_ZONES: readonly string[] = [
  'Asia/Kolkata',
  'UTC',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Zurich',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/** Every named zone the browser knows, or the common ones when it cannot list them. */
function knownZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return COMMON_ZONES;
  }
}

/**
 * How many zones the menu shows without a search: the common ones, and the current setting if it
 * is not one of them. The menu is short, so it never needs a scroll bar (which a keyboard cannot reach).
 */
export function timeZoneMenuSize(current: string): number {
  return COMMON_ZONES.length + (COMMON_ZONES.includes(current) ? 0 : 1);
}

/**
 * The choices of the time-zone menu: the current setting if it is not a common zone, then the
 * common zones, then all the others in order. Each zone once; only named zones, as the settings
 * contract accepts (no fixed offsets).
 */
export function timeZoneOptions(current: string): { value: string; label: string }[] {
  const others = [...new Set(knownZones())]
    .filter((zone) => !COMMON_ZONES.includes(zone) && zone !== current)
    .sort();
  const head = COMMON_ZONES.includes(current) ? COMMON_ZONES : [current, ...COMMON_ZONES];
  return [...head, ...others].map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }));
}
