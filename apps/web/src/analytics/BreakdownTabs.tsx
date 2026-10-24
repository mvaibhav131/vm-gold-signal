import { Table, Tabs, Text } from '@mantine/core';
import { BREAKDOWN_DIMENSIONS, type BreakdownDimension, type BreakdownRow } from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';
import { useState } from 'react';

import { useBreakdown } from '../data/queries';
import { formatFactor, formatR, rClass } from '../format/signal';
import { DIMENSION_LABELS, breakdownKeyLabel } from './labels';
import { DASH, QueryBoundary, RateText, SampleBadge, ScrollBox, Section } from './parts';

/** The rows of one dimension, the biggest sample first (as the API sends them). */
export function BreakdownTable({
  by,
  rows,
}: {
  by: BreakdownDimension;
  rows: readonly BreakdownRow[];
}) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid={`breakdown-${by}`}>
        No valid results in this scope yet.
      </Text>
    );
  }
  return (
    <ScrollBox label={`Results by ${DIMENSION_LABELS[by].toLowerCase()}, scrolls sideways`}>
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={640}
        data-testid={`breakdown-${by}`}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{DIMENSION_LABELS[by]}</Table.Th>
            <Table.Th ta="right">Results</Table.Th>
            <Table.Th ta="right">Wins</Table.Th>
            <Table.Th ta="right">Win rate</Table.Th>
            <Table.Th ta="right">Expectancy</Table.Th>
            <Table.Th ta="right">Profit factor</Table.Th>
            <Table.Th>Sample</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.key} data-testid={`breakdown-${by}-row-${row.key}`}>
              <Table.Th scope="row" fw={600}>
                {breakdownKeyLabel(by, row.key)}
              </Table.Th>
              <Table.Td ta="right">{row.n}</Table.Td>
              <Table.Td ta="right">{row.wins}</Table.Td>
              <Table.Td ta="right">
                <RateText rate={row.winRate} ci={row.ci95} />
              </Table.Td>
              <Table.Td ta="right">
                {row.expectancyR === null ? (
                  DASH
                ) : (
                  <span className={rClass(row.expectancyR)}>{formatR(row.expectancyR)}</span>
                )}
              </Table.Td>
              <Table.Td ta="right">
                {row.profitFactor === null ? DASH : formatFactor(row.profitFactor)}
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

function BreakdownPanel({ scope, by }: { scope: StatsScope; by: BreakdownDimension }) {
  const query = useBreakdown(scope, by);
  return (
    <QueryBoundary query={query} what={`the results by ${DIMENSION_LABELS[by].toLowerCase()}`}>
      {({ items }) => <BreakdownTable by={by} rows={items} />}
    </QueryBoundary>
  );
}

/** One tab for each dimension. Only the open tab is loaded. */
export function BreakdownTabs({ scope }: { scope: StatsScope }) {
  const [by, setBy] = useState<BreakdownDimension>('strategy');
  return (
    <Section
      title="Where it works and where it does not"
      description="The same results split by one property at a time. A win means net R above zero after costs. A win rate needs at least 30 results and carries the label Low sample below 100."
    >
      <Tabs
        value={by}
        onChange={(value) => {
          const next = BREAKDOWN_DIMENSIONS.find((dimension) => dimension === value);
          if (next) setBy(next);
        }}
        keepMounted={false}
      >
        <Tabs.List className="tabs-scroll" aria-label="Split the results by">
          {BREAKDOWN_DIMENSIONS.map((dimension) => (
            <Tabs.Tab key={dimension} value={dimension}>
              {DIMENSION_LABELS[dimension]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {BREAKDOWN_DIMENSIONS.map((dimension) => (
          <Tabs.Panel key={dimension} value={dimension} pt="sm">
            <BreakdownPanel scope={scope} by={dimension} />
          </Tabs.Panel>
        ))}
      </Tabs>
    </Section>
  );
}
