import { Select, Stack, Table, Text } from '@mantine/core';
import type { GroupEffectivenessRow } from '@vmgs/contracts';
import {
  QUALITY_GROUPS,
  STRATEGY_KEYS,
  type GroupState,
  type StatsScope,
  type StrategyKey,
} from '@vmgs/core';
import { useState } from 'react';

import { useGroupEffectiveness } from '../data/queries';
import { GROUP_LABELS, STRATEGY_LABELS, formatInterval, formatPercent } from '../format/signal';
import { DASH, QueryBoundary, ScrollBox, Section } from './parts';
import { EVIDENCE_NORMAL_SAMPLE, EVIDENCE_MIN_SAMPLE } from '@vmgs/core';

const STATE_LABELS: Readonly<Record<GroupState, string>> = {
  STRONG: 'Strong',
  OK: 'OK',
  WEAK: 'Weak',
  FAIL: 'Fail',
  NA: 'Not applicable',
};

const STATES: readonly GroupState[] = ['STRONG', 'OK', 'WEAK', 'FAIL'];

function Cell({ row }: { row: GroupEffectivenessRow }) {
  const note =
    row.n < EVIDENCE_MIN_SAMPLE
      ? 'insufficient evidence'
      : row.n < EVIDENCE_NORMAL_SAMPLE
        ? 'low sample'
        : null;
  return (
    <div>
      <div>{row.winRate === null ? DASH : formatPercent(row.winRate)}</div>
      {row.ci95 !== null && (
        <Text size="xs" c="dimmed">
          95% CI {formatInterval(row.ci95)}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        n = {row.n}
        {note === null ? '' : `, ${note}`}
      </Text>
    </div>
  );
}

/**
 * The rows of one strategy as a matrix: for each evidence group, how the signals that had it
 * STRONG, OK, WEAK or FAIL at entry ended. The states are shown side by side instead of merged,
 * so that every number and interval is the one the API computed.
 */
export function GroupMatrix({ rows }: { rows: readonly GroupEffectivenessRow[] }) {
  const hasNa = rows.some((row) => row.state === 'NA' && row.n > 0);
  const states: readonly GroupState[] = hasNa ? [...STATES, 'NA'] : STATES;
  return (
    <ScrollBox label="Evidence groups by state at entry, scrolls sideways">
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={680}
        data-testid="group-effectiveness"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Evidence group</Table.Th>
            {states.map((state) => (
              <Table.Th key={state}>{STATE_LABELS[state]} at entry</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {QUALITY_GROUPS.map((group) => (
            <Table.Tr key={group} data-testid={`group-row-${group}`}>
              <Table.Th scope="row" fw={600}>
                {GROUP_LABELS[group]}
              </Table.Th>
              {states.map((state) => {
                const row = rows.find(
                  (candidate) => candidate.group === group && candidate.state === state,
                );
                return (
                  <Table.Td key={state} data-testid={`group-cell-${group}-${state}`}>
                    {row ? <Cell row={row} /> : DASH}
                  </Table.Td>
                );
              })}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

/** The group view of a scope: a choice of strategy and the matrix of that strategy. The choice falls back to the first strategy when the one chosen has no results in this scope. */
export function GroupView({ rows }: { rows: readonly GroupEffectivenessRow[] }) {
  const present = STRATEGY_KEYS.filter((key) => rows.some((row) => row.strategy === key));
  const [chosen, setChosen] = useState<StrategyKey | null>(null);
  const strategy = chosen !== null && present.includes(chosen) ? chosen : present[0];
  if (strategy === undefined) {
    return (
      <Text size="sm" c="dimmed" data-testid="group-effectiveness">
        No valid results in this scope yet.
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      <Select
        label="Strategy"
        data={present.map((key) => ({ value: key, label: STRATEGY_LABELS[key] }))}
        value={strategy}
        onChange={(value) => {
          setChosen(present.find((key) => key === value) ?? null);
        }}
        allowDeselect={false}
        maw={320}
        data-testid="group-strategy"
      />
      <GroupMatrix rows={rows.filter((row) => row.strategy === strategy)} />
      <Text size="xs" c="dimmed">
        A dash means no result had the group in that state. If a group matters, the Strong and OK
        columns should win more often than Weak and Fail. A win rate needs at least 30 results.
      </Text>
    </Stack>
  );
}

export function GroupEffectiveness({ scope }: { scope: StatsScope }) {
  const query = useGroupEffectiveness(scope);
  return (
    <Section
      title="Which evidence groups matter"
      description="The indicator-level view: for each group of the quality score, how the signals ended depending on how that group looked at entry."
    >
      <QueryBoundary query={query} what="the evidence groups">
        {({ items }) => <GroupView rows={items} />}
      </QueryBoundary>
    </Section>
  );
}
