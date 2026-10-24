import { Text, VisuallyHidden } from '@mantine/core';
import { sampleLabel } from '@vmgs/core';

import { DASH } from '../components/page';
import { ToneBadge } from '../components/ToneBadge';
import { formatInterval, formatPercent } from '../format/signal';

// The blocks that every screen with a table uses live in `components/page`.
export { Bar, DASH, QueryBoundary, ScrollBox, Section, barPercent } from '../components/page';

/** The warning under a sample: "Insufficient evidence" below 30 results, "Low sample" below 100, nothing from 100 (rule C6). */
export function SampleBadge({ n }: { n: number }) {
  const label = sampleLabel(n);
  if (label === 'NORMAL') return null;
  return (
    <ToneBadge tone="warning" size="sm">
      {label === 'INSUFFICIENT' ? 'Insufficient evidence' : 'Low sample'}
    </ToneBadge>
  );
}

/**
 * A rate as the API sent it. The API sends no rate below 30 results: then only a dash is shown (the
 * counts are in the columns next to it) and screen readers hear why.
 */
export function RateText({
  rate,
  ci,
}: {
  rate: number | null;
  ci?: readonly [number, number] | null;
}) {
  if (rate === null) {
    return (
      <span>
        {DASH}
        <VisuallyHidden>Insufficient evidence</VisuallyHidden>
      </span>
    );
  }
  return (
    <span>
      {formatPercent(rate)}
      {ci ? (
        <Text span size="xs" c="dimmed">
          {' '}
          (95% CI {formatInterval(ci)})
        </Text>
      ) : null}
    </span>
  );
}
