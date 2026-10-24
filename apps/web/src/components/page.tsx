import { Alert, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';

/** What a value that is not there is shown as. */
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

/** One block of a page: a heading, a short explanation and the content. */
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

/** Loading, error with a retry button, or the data. Data of another key is never shown while a key loads. */
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
