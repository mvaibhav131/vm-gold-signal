import { useDisplayTz } from '../data/queries';
import { formatClock, formatDateTime, formatUtc } from '../format/time';

/**
 * A time in the display time zone (default IST) with the UTC time in the tooltip
 * (05_UI_Spec section 1). The machine-readable value stays in `dateTime`.
 */
export function TimeText({ iso, withDate = false }: { iso: string; withDate?: boolean }) {
  const timeZone = useDisplayTz();
  return (
    <time dateTime={iso} title={formatUtc(iso)}>
      {withDate ? formatDateTime(iso, timeZone) : formatClock(iso, timeZone)}
    </time>
  );
}
