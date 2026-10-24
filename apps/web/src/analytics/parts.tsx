import { Alert, Button, Group, Paper, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import { sampleLabel } from '@vmgs/core';
import { useId, type ReactNode } from 'react';

import { ToneBadge } from '../components/ToneBadge';
import { formatInterval, formatPercent } from '../format/signal';

export const DASH = '\u2013';

/** A fraction as the width or position of a bar, with one decimal (no floating point noise in the style). */
export function barPercent(fraction: number): string {
  return `${String(Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10)}%`;
}

/** A horizontal bar: the width is the value, and the numbers next to it say the same in words. */
export function Bar({ fraction }: { fraction: number }) {
  return (
    <div className="bar-track" aria-hidden="true">
      <div className="bar-fill" style={{ width: barPercent(fraction) }} />
    </div>
  );
}

/** One block of the page: a heading, a short explanation and the content. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Paper withBorder p="md" radius="md" component="section" aria-labelledby={headingId}>
      <Stack gap="sm">
        <div>
          <Title order={2} size="h4" id={headingId}>
            {title}
          </Title>
          {description !== undefined && (
            <Text size="sm" c="dimmed" maw={820}>
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Paper>
  );
}

/** Loading, error with a retry button, or the data. The data of another scope is never shown while a scope loads. */
export function QueryBoundary<T>({
  query,
  what,
  children,
}: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) {
    return (
      <Alert color="negative" role="alert" title={`Could not load ${what}`}>
        <Group gap="sm">
          <Text size="sm">Check the connection and try again.</Text>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </Button>
        </Group>
      </Alert>
    );
  }
  return (
    <Text size="sm" c="dimmed" role="status">
      Loading…
    </Text>
  );
}

/** A box that scrolls sideways by itself, so the page never does. It can be reached with the keyboard. */
export function ScrollBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="scroll-x" role="region" tabIndex={0} aria-label={label}>
      {children}
    </div>
  );
}

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
