import { Stack, Table, Text } from '@mantine/core';
import type { DriftRow, DriftStatus } from '@vmgs/contracts';
import type { StrategyKey, StrategyStatus } from '@vmgs/core';

import { ToneBadge } from '../components/ToneBadge';
import { useDrift, useStrategies } from '../data/queries';
import type { Tone } from '../format/format';
import { STRATEGY_LABELS, formatInterval } from '../format/signal';
import { sentenceCase } from './labels';
import { DASH, QueryBoundary, RateText, ScrollBox, Section, barPercent } from './parts';

export const DRIFT_CHIPS: Readonly<Record<DriftStatus, { text: string; tone: Tone }>> = {
  INSUFFICIENT_DATA: { text: 'Insufficient data', tone: 'neutral' },
  WITHIN_RANGE: { text: 'Within the backtest range', tone: 'positive' },
  BELOW_RANGE: { text: 'Below the backtest range', tone: 'warning' },
  ABOVE_RANGE: { text: 'Above the backtest range', tone: 'info' },
};

/** The backtest interval as a band on a 0 to 100% scale, with the rolling win rate as a mark. Decoration only: the numbers are in the text. */
function RangeBar({ row }: { row: DriftRow }) {
  if (row.evidenceCi95 === null) return null;
  const [low, high] = row.evidenceCi95;
  return (
    <div className="range-track" aria-hidden="true">
      <div
        className="range-band"
        style={{ left: barPercent(low), width: barPercent(high - low) }}
      />
      {row.rollingWinRate !== null && (
        <div className="range-mark" style={{ left: barPercent(row.rollingWinRate) }} />
      )}
    </div>
  );
}

/**
 * The rolling win rate of the last forward results of each strategy against the interval of its
 * backtest. This is a warning light, not a verdict. Below 30 results there is no rate: only the count.
 */
export function DriftTable({
  rows,
  statuses,
}: {
  rows: readonly DriftRow[];
  statuses: Readonly<Partial<Record<StrategyKey, StrategyStatus>>>;
}) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="drift-panel">
        No strategy has forward results to compare yet.
      </Text>
    );
  }
  return (
    <ScrollBox label="Drift by strategy, scrolls sideways">
      <Table verticalSpacing={8} horizontalSpacing="xs" fz="sm" miw={720} data-testid="drift-panel">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Strategy</Table.Th>
            <Table.Th>Strategy status</Table.Th>
            <Table.Th ta="right">Results in the window</Table.Th>
            <Table.Th ta="right">Rolling win rate</Table.Th>
            <Table.Th>Backtest range</Table.Th>
            <Table.Th>Drift</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => {
            const status = statuses[row.strategy];
            const chip = DRIFT_CHIPS[row.status];
            return (
              <Table.Tr key={row.strategy} data-testid={`drift-row-${row.strategy}`}>
                <Table.Th scope="row" fw={600}>
                  {STRATEGY_LABELS[row.strategy]}
                </Table.Th>
                <Table.Td>{status === undefined ? DASH : sentenceCase(status)}</Table.Td>
                <Table.Td ta="right">
                  {row.n} of {row.window}
                </Table.Td>
                <Table.Td ta="right">
                  <RateText rate={row.rollingWinRate} />
                </Table.Td>
                <Table.Td miw={180}>
                  {row.evidenceCi95 === null ? (
                    <Text size="sm" c="dimmed">
                      No backtest interval
                    </Text>
                  ) : (
                    <Stack gap={4}>
                      <Text size="sm">95% CI {formatInterval(row.evidenceCi95)}</Text>
                      <RangeBar row={row} />
                    </Stack>
                  )}
                </Table.Td>
                <Table.Td>
                  <ToneBadge
                    tone={chip.tone}
                    size="sm"
                    data-testid={`drift-status-${row.strategy}`}
                  >
                    {chip.text}
                  </ToneBadge>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

export function DriftPanel() {
  const query = useDrift();
  const strategies = useStrategies();
  const statuses = Object.fromEntries(
    (strategies.data ?? []).map((strategy) => [strategy.key, strategy.status]),
  );
  return (
    <Section
      title="Is it still behaving like the backtest?"
      description="The win rate of the last 50 forward results of each strategy, compared with the 95% interval of the backtest of the same strategy. It needs 30 results. Below the range is a warning to look closer, not a verdict."
    >
      <QueryBoundary query={query} what="the drift panel">
        {({ items }) => <DriftTable rows={items} statuses={statuses} />}
      </QueryBoundary>
    </Section>
  );
}
