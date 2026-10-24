import { Anchor, Badge, Paper, Stack, Table, Text } from '@mantine/core';
import { Link } from 'react-router';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useRecentSignals } from '../data/queries';
import { STRATEGY_LABELS, formatR, resultChip, signalLabel } from '../format/signal';

/** The last five signals, open ones first (05_UI_Spec section 4). The full list is on the Signals screen. */
export function RecentSignals() {
  const recent = useRecentSignals(5);
  const rows = recent.data?.items ?? [];

  return (
    <Paper withBorder p="md" radius="md" className="dash-recent" data-testid="recent-signals">
      <Stack gap="sm">
        <Text fw={700}>Recent signals</Text>
        {recent.isPending && (
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        )}
        {recent.isSuccess && rows.length === 0 && (
          <Text size="sm" c="dimmed">
            No signal has been produced yet.
          </Text>
        )}
        {rows.length > 0 && (
          <div className="scroll-x">
            <Table verticalSpacing={6} horizontalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Time</Table.Th>
                  <Table.Th>#</Table.Th>
                  <Table.Th>Side</Table.Th>
                  <Table.Th>Strategy</Table.Th>
                  <Table.Th>Result</Table.Th>
                  <Table.Th ta="right">Net R</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => {
                  const chip = resultChip(row.result, row.state);
                  return (
                    <Table.Tr key={row.signalId} data-testid={`recent-row-${String(row.seq)}`}>
                      <Table.Td>
                        <TimeText iso={row.generatedAt} />
                      </Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={`/signals/${row.signalId}`}>
                          {signalLabel(row.seq)}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={row.side === 'BUY' ? 'positive' : 'negative'}
                        >
                          {row.side}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{STRATEGY_LABELS[row.strategyKey]}</Table.Td>
                      <Table.Td>
                        <ToneBadge tone={chip.tone} size="sm">
                          {chip.text}
                        </ToneBadge>
                      </Table.Td>
                      <Table.Td ta="right">
                        {row.realizedRNet === null ? '\u2013' : formatR(row.realizedRNet)}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        )}
        <Anchor component={Link} to="/signals" size="sm">
          All signals
        </Anchor>
      </Stack>
    </Paper>
  );
}
