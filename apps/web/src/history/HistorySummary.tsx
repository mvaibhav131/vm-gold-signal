import { Group, Paper, Stack, Text } from '@mantine/core';
import { EVIDENCE_NORMAL_SAMPLE } from '@vmgs/core';
import type { OverviewResponse } from '@vmgs/contracts';
import type { ReactNode } from 'react';

import { ToneBadge } from '../components/ToneBadge';
import { formatDuration } from '../format/time';
import { formatFactor, formatR, rClass, winRateText } from '../format/signal';

function Stat({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} data-testid={testId} component="div">
        {children}
      </Text>
    </div>
  );
}

/**
 * The strip above the table: the counters of the WHOLE filtered list (not only the rows that are
 * loaded). A win rate is shown from 30 valid results, with a "Low sample" label below 100 (rule C6).
 */
export function HistorySummary({
  summary,
  filtered,
}: {
  summary: OverviewResponse | undefined;
  filtered: boolean;
}) {
  if (!summary) {
    return (
      <Paper withBorder p="md" radius="md" data-testid="history-summary">
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      </Paper>
    );
  }
  const lowSample = summary.winRate !== null && summary.resolvedValid < EVIDENCE_NORMAL_SAMPLE;
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-label={filtered ? 'Summary of the filtered signals' : 'Summary of all signals'}
      data-testid="history-summary"
    >
      <Stack gap="xs">
        <Group gap="xl" align="flex-start">
          <Stat label="Signals" testId="summary-signals">
            {String(summary.generated)}
          </Stat>
          <Stat label="Properly tracked (valid results)" testId="summary-valid">
            {String(summary.resolvedValid)}
          </Stat>
          <Stat label="Win rate" testId="summary-win-rate">
            <Group gap="xs" wrap="wrap">
              <span>{winRateText(summary)}</span>
              {lowSample && <ToneBadge tone="warning">Low sample</ToneBadge>}
            </Group>
          </Stat>
          <Stat label="Net R" testId="summary-net-r">
            <span className={rClass(summary.netR)}>{formatR(summary.netR)}</span>
          </Stat>
          <Stat label="Profit factor" testId="summary-profit-factor">
            {summary.profitFactor === null ? '\u2013' : formatFactor(summary.profitFactor)}
          </Stat>
          {summary.avgDurationS !== null && (
            <Stat label="Average duration" testId="summary-duration">
              {formatDuration(summary.avgDurationS)}
            </Stat>
          )}
        </Group>
        <Text size="xs" c="dimmed" data-testid="summary-note">
          {filtered ? 'For the current filters. ' : ''}
          Cancelled {summary.cancelled} and data-invalid {summary.dataInvalid} signals are counted
          apart. A win means net R above zero after costs.
        </Text>
      </Stack>
    </Paper>
  );
}
