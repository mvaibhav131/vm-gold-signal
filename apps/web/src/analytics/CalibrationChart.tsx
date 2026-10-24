import { Group, Table, Text } from '@mantine/core';
import type { CalibrationRow } from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';

import { useCalibration } from '../data/queries';
import { Bar, DASH, QueryBoundary, RateText, SampleBadge, ScrollBox, Section } from './parts';

/** `65-69`, with an en dash. */
export function bandText(row: { bandFrom: number; bandTo: number }): string {
  return `${String(row.bandFrom)}\u2013${String(row.bandTo)}`;
}

/** Quality-score bands against the realised win rate. A bar is drawn only where the API sent a rate (30 results or more). */
export function CalibrationTable({ rows }: { rows: readonly CalibrationRow[] }) {
  return (
    <ScrollBox label="Score calibration, scrolls sideways">
      <Table verticalSpacing={6} horizontalSpacing="xs" fz="sm" miw={560} data-testid="calibration">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Quality score</Table.Th>
            <Table.Th ta="right">Results</Table.Th>
            <Table.Th ta="right">Wins</Table.Th>
            <Table.Th>Win rate</Table.Th>
            <Table.Th>Sample</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr
              key={row.bandFrom}
              data-testid={`calibration-row-${String(row.bandFrom)}-${String(row.bandTo)}`}
            >
              <Table.Th scope="row" fw={600}>
                {bandText(row)}
              </Table.Th>
              <Table.Td ta="right">{row.n}</Table.Td>
              <Table.Td ta="right">{row.wins}</Table.Td>
              <Table.Td miw={220}>
                {row.winRate === null ? (
                  <RateText rate={null} />
                ) : (
                  <Group gap="xs" wrap="nowrap">
                    <Bar fraction={row.winRate} />
                    <RateText rate={row.winRate} ci={row.ci95} />
                  </Group>
                )}
              </Table.Td>
              <Table.Td>{row.n === 0 ? DASH : <SampleBadge n={row.n} />}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

export function CalibrationSection({ scope }: { scope: StatsScope }) {
  const query = useCalibration(scope);
  return (
    <Section
      title="Does a higher score win more often?"
      description="The quality score is a setup-quality number, not a probability. If the win rate does not rise from band to band, the score is not helping to pick better signals."
    >
      <QueryBoundary query={query} what="the score calibration">
        {({ items }) => (
          <>
            <CalibrationTable rows={items} />
            <Text size="xs" c="dimmed">
              A band with fewer than 30 results shows its counts only. A band with no result is
              still listed, so the scale is always the same.
            </Text>
          </>
        )}
      </QueryBoundary>
    </Section>
  );
}
