import { Table, Text } from '@mantine/core';
import type { MonthlyRow } from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';

import { useDisplayTz, useMonthly } from '../data/queries';
import { zoneLabel } from '../format/time';
import { formatFactor, formatPercent, formatR, rClass } from '../format/signal';
import { DASH, QueryBoundary, ScrollBox, Section } from './parts';
import { VisuallyHidden } from '@mantine/core';
import { EVIDENCE_NORMAL_SAMPLE } from '@vmgs/core';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `2026-07` becomes `Jul 2026`. */
export function monthText(month: string): string {
  const [year = '', number = '1'] = month.split('-');
  return `${MONTH_NAMES[Number(number) - 1] ?? number} ${year}`;
}

function WinRateCell({ row }: { row: MonthlyRow }) {
  if (row.winRate === null) {
    return (
      <span>
        {DASH}
        <VisuallyHidden>Insufficient evidence</VisuallyHidden>
      </span>
    );
  }
  return (
    <span>
      {formatPercent(row.winRate)}
      {row.resolvedValid < EVIDENCE_NORMAL_SAMPLE && (
        <Text span size="xs" c="dimmed">
          {' '}
          low sample
        </Text>
      )}
    </span>
  );
}

/** One row for each month, from the API. A month with fewer than 30 valid results shows counts and a dash instead of the win rate. */
export function MonthlyTable({ rows }: { rows: readonly MonthlyRow[] }) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="monthly-table">
        No signals in this scope yet.
      </Text>
    );
  }
  return (
    <ScrollBox label="Monthly table, scrolls sideways">
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={860}
        data-testid="monthly-table"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Month</Table.Th>
            <Table.Th ta="right">Generated</Table.Th>
            <Table.Th ta="right">Properly tracked</Table.Th>
            <Table.Th ta="right">Wins</Table.Th>
            <Table.Th ta="right">Partial wins</Table.Th>
            <Table.Th ta="right">Losses</Table.Th>
            <Table.Th ta="right">Time exits</Table.Th>
            <Table.Th ta="right">Cancelled</Table.Th>
            <Table.Th ta="right">Data invalid</Table.Th>
            <Table.Th ta="right">Win rate</Table.Th>
            <Table.Th ta="right">Net R</Table.Th>
            <Table.Th ta="right">Profit factor</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.month} data-testid={`monthly-row-${row.month}`}>
              <Table.Th scope="row" fw={600}>
                {monthText(row.month)}
              </Table.Th>
              <Table.Td ta="right">{row.generated}</Table.Td>
              <Table.Td ta="right">{row.resolvedValid}</Table.Td>
              <Table.Td ta="right">{row.wins}</Table.Td>
              <Table.Td ta="right">{row.partials}</Table.Td>
              <Table.Td ta="right">{row.losses}</Table.Td>
              <Table.Td ta="right">{row.timeExits}</Table.Td>
              <Table.Td ta="right">{row.cancelled}</Table.Td>
              <Table.Td ta="right">{row.dataInvalid}</Table.Td>
              <Table.Td ta="right">
                <WinRateCell row={row} />
              </Table.Td>
              <Table.Td ta="right">
                <span className={rClass(row.netR)}>{formatR(row.netR)}</span>
              </Table.Td>
              <Table.Td ta="right">
                {row.profitFactor === null ? DASH : formatFactor(row.profitFactor)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

export function MonthlySection({ scope }: { scope: StatsScope }) {
  const query = useMonthly(scope);
  const timeZone = useDisplayTz();
  return (
    <Section
      title="Month by month"
      description={`How many signals came each month and how many were properly tracked. Months follow the display time zone (${zoneLabel(timeZone)}). A month rarely has 30 valid results, so most win rates here are a dash: that is honest, not missing data.`}
    >
      <QueryBoundary query={query} what="the monthly table">
        {({ items }) => <MonthlyTable rows={items} />}
      </QueryBoundary>
    </Section>
  );
}
