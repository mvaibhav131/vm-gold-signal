import { Accordion, Group, List, Stack, Table, Text, Title, VisuallyHidden } from '@mantine/core';
import type { FailuresResponse } from '@vmgs/contracts';
import { CAUSE_CODES, EVIDENCE_MIN_SAMPLE, type StatsScope } from '@vmgs/core';

import { ToneBadge } from '../components/ToneBadge';
import { useFailures } from '../data/queries';
import {
  CATEGORY_LABELS,
  CATEGORY_TONE,
  CAUSE_LABELS,
  CAUSE_RULES,
  GROUP_LABELS,
  formatPercent,
  formatR,
  rClass,
} from '../format/signal';
import { Bar, DASH, QueryBoundary, ScrollBox, Section } from './parts';

/** A bar relative to the biggest count of the table (a scale for the eye, not a statistic). */
const relative = (value: number, max: number) => (max > 0 ? value / max : 0);

/** A share of the reviewed results. Like every percentage, it appears only from 30 results (rule C6). */
function ShareText({ share, shown }: { share: number; shown: boolean }) {
  return shown ? (
    <span>{formatPercent(share)}</span>
  ) : (
    <span>
      {DASH}
      <VisuallyHidden>Insufficient evidence</VisuallyHidden>
    </span>
  );
}

/** The primary causes of the reviewed results, and the groups that were weak at entry. */
export function FailureView({ data }: { data: FailuresResponse }) {
  const reviewed = data.causes.reduce((sum, cause) => sum + cause.n, 0);
  if (reviewed === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="failure-causes">
        No reviewed results in this scope yet.
      </Text>
    );
  }
  const showShare = reviewed >= EVIDENCE_MIN_SAMPLE;
  const maxCause = Math.max(...data.causes.map((cause) => cause.n));
  const maxGroup = Math.max(0, ...data.weakGroups.map((group) => group.n));
  return (
    <Stack gap="md">
      <Text size="sm" data-testid="failure-total">
        {reviewed} reviewed results (every valid result that was not a clean win).
        {showShare ? '' : ' Fewer than 30, so shares are not shown, only counts.'}
      </Text>
      <ScrollBox label="Primary causes, scrolls sideways">
        <Table
          verticalSpacing={6}
          horizontalSpacing="xs"
          fz="sm"
          miw={560}
          data-testid="failure-causes"
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Primary cause</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Results</Table.Th>
              <Table.Th ta="right">Share</Table.Th>
              <Table.Th ta="right">Net R</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.causes.map((cause) => (
              <Table.Tr key={cause.code} data-testid={`failure-row-${cause.code}`}>
                <Table.Th scope="row" fw={600}>
                  {CAUSE_LABELS[cause.code]}
                </Table.Th>
                <Table.Td>
                  <ToneBadge tone={CATEGORY_TONE[cause.category]} size="sm">
                    {CATEGORY_LABELS[cause.category]}
                  </ToneBadge>
                </Table.Td>
                <Table.Td miw={120}>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" w={24} ta="right" component="span">
                      {cause.n}
                    </Text>
                    <Bar fraction={relative(cause.n, maxCause)} />
                  </Group>
                </Table.Td>
                <Table.Td ta="right">
                  <ShareText share={cause.share} shown={showShare} />
                </Table.Td>
                <Table.Td ta="right">
                  <span className={rClass(cause.sumR)}>{formatR(cause.sumR)}</span>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollBox>

      <Stack gap="xs">
        <Title order={3} size="h5">
          Weak groups at entry
        </Title>
        <Text size="sm" c="dimmed">
          How often an evidence group was WEAK or FAIL when the signal was created, among the
          reviewed results. One result can count for several groups.
        </Text>
        {data.weakGroups.length === 0 ? (
          <Text size="sm" c="dimmed">
            No group was weak at entry in these results.
          </Text>
        ) : (
          <ScrollBox label="Weak groups at entry, scrolls sideways">
            <Table
              verticalSpacing={6}
              horizontalSpacing="xs"
              fz="sm"
              miw={420}
              data-testid="weak-groups"
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Evidence group</Table.Th>
                  <Table.Th>Results</Table.Th>
                  <Table.Th ta="right">Share of reviewed</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.weakGroups.map((entry) => (
                  <Table.Tr key={entry.group} data-testid={`weak-group-${entry.group}`}>
                    <Table.Th scope="row" fw={600}>
                      {GROUP_LABELS[entry.group]}
                    </Table.Th>
                    <Table.Td miw={120}>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm" w={24} ta="right" component="span">
                          {entry.n}
                        </Text>
                        <Bar fraction={relative(entry.n, maxGroup)} />
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right">
                      <ShareText share={entry.share} shown={showShare} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollBox>
        )}
      </Stack>

      <Accordion variant="separated" radius="md">
        <Accordion.Item value="rules">
          <Accordion.Control>How each cause is decided</Accordion.Control>
          <Accordion.Panel>
            <List size="sm" spacing="xs" data-testid="failure-rules">
              {CAUSE_CODES.map((code) => (
                <List.Item key={code}>
                  <strong>{CAUSE_LABELS[code]}:</strong> {CAUSE_RULES[code]}
                </List.Item>
              ))}
            </List>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

export function FailureAnalysis({ scope }: { scope: StatsScope }) {
  const query = useFailures(scope);
  return (
    <Section
      title="Why signals failed"
      description="Heuristic attribution: fixed rules applied to each reviewed result. It shows where to look, not why the market moved. Judge a strategy by its statistics, not by one cause."
    >
      <QueryBoundary query={query} what="the failure analysis">
        {(data) => <FailureView data={data} />}
      </QueryBoundary>
    </Section>
  );
}
