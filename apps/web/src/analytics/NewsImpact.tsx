import { Table, Text } from '@mantine/core';
import type { NewsImpactRow } from '@vmgs/contracts';

import { useNewsImpact } from '../data/queries';
import { formatFixed } from '../format/format';
import { IMPACT_LABELS, TOPIC_LABELS } from '../format/news';
import { formatPercent } from '../format/signal';
import { DASH, QueryBoundary, RateText, SampleBadge, ScrollBox, Section } from './parts';

/**
 * How often gold moved 1 ATR or more within 10 minutes after a headline of one topic and impact
 * level, compared with ordinary windows. It is an association, never a cause. Below 30 headlines
 * there is no share and no lift.
 */
export function NewsImpactTable({ rows }: { rows: readonly NewsImpactRow[] }) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="news-impact">
        No headlines have been measured yet.
      </Text>
    );
  }
  return (
    <ScrollBox label="News impact by topic, scrolls sideways">
      <Table verticalSpacing={6} horizontalSpacing="xs" fz="sm" miw={880} data-testid="news-impact">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Topic</Table.Th>
            <Table.Th>Impact</Table.Th>
            <Table.Th ta="right">Headlines</Table.Th>
            <Table.Th ta="right">Gold moved 1 ATR or more</Table.Th>
            <Table.Th ta="right">Share</Table.Th>
            <Table.Th ta="right">Ordinary windows</Table.Th>
            <Table.Th ta="right">Compared with ordinary</Table.Th>
            <Table.Th>Sample</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr
              key={`${row.topic}-${row.impact}`}
              data-testid={`news-impact-row-${row.topic}-${row.impact}`}
            >
              <Table.Th scope="row" fw={600}>
                {TOPIC_LABELS[row.topic]}
              </Table.Th>
              <Table.Td>{IMPACT_LABELS[row.impact]}</Table.Td>
              <Table.Td ta="right">{row.n}</Table.Td>
              <Table.Td ta="right">{row.moved}</Table.Td>
              <Table.Td ta="right">
                <RateText rate={row.movedShare} ci={row.movedCi95} />
              </Table.Td>
              <Table.Td ta="right">
                {row.movedShare === null || row.baselineShare === null
                  ? DASH
                  : formatPercent(row.baselineShare)}
              </Table.Td>
              <Table.Td ta="right">
                {row.lift === null ? DASH : `${formatFixed(row.lift, 2)}\u00d7`}
              </Table.Td>
              <Table.Td>
                <SampleBadge n={row.n} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

export function NewsImpact() {
  const query = useNewsImpact();
  return (
    <Section
      title="Do headlines go with bigger gold moves?"
      description="After a headline of each topic and impact level: how often gold moved 1 ATR or more within 10 minutes, compared with ordinary 10-minute windows. This is an association, not a cause: other things happen at the same time. A share needs at least 30 headlines."
    >
      <QueryBoundary query={query} what="the news impact">
        {({ items }) => <NewsImpactTable rows={items} />}
      </QueryBoundary>
    </Section>
  );
}
