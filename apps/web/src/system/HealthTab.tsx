import { Button, Group, Stack, Table, Text } from '@mantine/core';
import type { FeedIncident, SystemLatency } from '@vmgs/contracts';
import { useState } from 'react';

import { PauseDialog } from '../dashboard/PauseDialog';
import { DASH, QueryBoundary, ScrollBox, Section } from '../components/page';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useEngineControls } from '../data/mutations';
import {
  useSnapshot,
  useSystemHealth,
  useSystemIncidents,
  useSystemLatency,
} from '../data/queries';
import type { Tone } from '../format/format';
import { formatSpan } from '../format/time';
import { useNow } from '../hooks';
import { healthChecks, summarizeChecks, type HealthLevel } from './health';

const LEVEL_CHIP: Readonly<Record<HealthLevel, { text: string; tone: Tone }>> = {
  OK: { text: 'OK', tone: 'positive' },
  DEGRADED: { text: 'DEGRADED', tone: 'warning' },
  DOWN: { text: 'DOWN', tone: 'negative' },
  UNKNOWN: { text: 'UNKNOWN', tone: 'neutral' },
};

const KIND_LABELS: Readonly<Record<FeedIncident['kind'], string>> = {
  DISCONNECT: 'Disconnect',
  STALE: 'Stale feed',
  GAP: 'Gap in the data',
  CLOCK_SKEW: 'Clock skew',
  SPREAD_SPIKE: 'Spread spike',
  MARKET_STATE: 'Market state',
};

function EngineCard() {
  const snapshot = useSnapshot();
  const { pause, resume } = useEngineControls();
  const [pausing, setPausing] = useState(false);
  const engine = snapshot.data?.engine;
  const paused = engine?.status === 'PAUSED';
  return (
    <Section
      title="Engine"
      description="While the engine is paused no new signal is produced and no signal alert is sent. Data keeps being recorded and open signals keep being tracked. The system never pauses itself."
    >
      {engine === undefined ? (
        <Text size="sm" c="dimmed" role="status">
          Loading…
        </Text>
      ) : (
        <Group gap="md" data-testid="health-engine">
          <ToneBadge tone={paused ? 'warning' : 'positive'} data-testid="health-engine-status">
            {paused ? 'PAUSED' : 'RUNNING'}
          </ToneBadge>
          {paused ? (
            <>
              {engine.pausedSince !== undefined && (
                <Text size="sm">
                  Paused since <TimeText iso={engine.pausedSince} withDate />
                </Text>
              )}
              <Button
                variant="default"
                size="xs"
                loading={resume.isPending}
                onClick={() => {
                  resume.mutate();
                }}
                data-testid="health-resume"
              >
                Resume engine
              </Button>
            </>
          ) : (
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                setPausing(true);
              }}
              data-testid="health-pause"
            >
              Pause engine
            </Button>
          )}
        </Group>
      )}
      <PauseDialog
        opened={pausing}
        onClose={() => {
          setPausing(false);
        }}
        onConfirm={(minutes) => {
          pause.mutate(minutes, {
            onSuccess: () => {
              setPausing(false);
            },
          });
        }}
        loading={pause.isPending}
      />
    </Section>
  );
}

function HealthSection() {
  const health = useSystemHealth();
  const snapshot = useSnapshot();
  const nowMs = useNow(5000);
  return (
    <Section
      title="Health"
      description="What the worker reports about itself. DEGRADED and DOWN say what is wrong in words; a value that is not known yet is UNKNOWN, never a guess."
    >
      <QueryBoundary query={health} what="the health">
        {(data) => {
          const checks = healthChecks(data, snapshot.data?.feedState, nowMs);
          const { attention, unknown } = summarizeChecks(checks);
          return (
            <Stack gap="sm">
              <Text size="sm" fw={600} role="status" data-testid="health-summary">
                {attention === 0 && unknown === 0
                  ? 'All checks are fine.'
                  : [
                      attention > 0
                        ? `${String(attention)} ${attention === 1 ? 'check needs' : 'checks need'} attention`
                        : null,
                      unknown > 0
                        ? `${String(unknown)} ${unknown === 1 ? 'check is' : 'checks are'} not known yet`
                        : null,
                    ]
                      .filter((part) => part !== null)
                      .join(', ') + '.'}
              </Text>
              <ScrollBox label="Health checks, scrolls sideways">
                <Table
                  verticalSpacing={6}
                  horizontalSpacing="xs"
                  fz="sm"
                  miw={560}
                  data-testid="health-checks"
                >
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Check</Table.Th>
                      <Table.Th>Value</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {checks.map((check) => (
                      <Table.Tr key={check.key} data-testid={`health-${check.key}`}>
                        <Table.Th scope="row" fw={600}>
                          {check.label}
                        </Table.Th>
                        <Table.Td data-testid={`health-${check.key}-value`}>{check.value}</Table.Td>
                        <Table.Td>
                          {check.level === null ? (
                            DASH
                          ) : (
                            <ToneBadge tone={LEVEL_CHIP[check.level].tone} size="sm">
                              {LEVEL_CHIP[check.level].text}
                            </ToneBadge>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollBox>
            </Stack>
          );
        }}
      </QueryBoundary>
    </Section>
  );
}

const LATENCY_ROWS: readonly { key: keyof SystemLatency; label: string }[] = [
  { key: 'feedLag', label: 'Feed lag (received after the source time)' },
  { key: 'candleToSignal', label: 'Candle close to signal' },
  { key: 'dbCommit', label: 'Database commit' },
  { key: 'notifyDispatch', label: 'Notification dispatch' },
];

const ms = (value: number | null) =>
  value === null ? 'not measured yet' : `${String(Math.round(value))} ms`;

function LatencySection() {
  const latency = useSystemLatency();
  return (
    <Section
      title="Latency"
      description="The median (p50) and the slowest 5% (p95) of each step, with the number of measurements."
    >
      <QueryBoundary query={latency} what="the latency">
        {(data) => (
          <ScrollBox label="Latency, scrolls sideways">
            <Table
              verticalSpacing={6}
              horizontalSpacing="xs"
              fz="sm"
              miw={480}
              data-testid="health-latency"
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Step</Table.Th>
                  <Table.Th ta="right">p50</Table.Th>
                  <Table.Th ta="right">p95</Table.Th>
                  <Table.Th ta="right">Measurements</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {LATENCY_ROWS.map(({ key, label }) => (
                  <Table.Tr key={key} data-testid={`latency-${key}`}>
                    <Table.Th scope="row" fw={600}>
                      {label}
                    </Table.Th>
                    <Table.Td ta="right">{ms(data[key].p50Ms)}</Table.Td>
                    <Table.Td ta="right">{ms(data[key].p95Ms)}</Table.Td>
                    <Table.Td ta="right">{data[key].samples}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollBox>
        )}
      </QueryBoundary>
    </Section>
  );
}

export function IncidentsTable({
  incidents,
  nowMs,
}: {
  incidents: readonly FeedIncident[];
  nowMs: number;
}) {
  if (incidents.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="health-incidents">
        No feed incident has been recorded.
      </Text>
    );
  }
  return (
    <ScrollBox label="Feed incidents, scrolls sideways">
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={640}
        data-testid="health-incidents"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Started</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Duration</Table.Th>
            <Table.Th>What happened</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {incidents.map((incident) => (
            <Table.Tr key={incident.id} data-testid={`incident-${String(incident.id)}`}>
              <Table.Td>
                <TimeText iso={incident.startedAt} withDate />
              </Table.Td>
              <Table.Th scope="row" fw={600}>
                {KIND_LABELS[incident.kind]}
              </Table.Th>
              <Table.Td>
                {incident.endedAt === null ? (
                  <ToneBadge tone="warning" size="sm">
                    Ongoing, {formatSpan((nowMs - Date.parse(incident.startedAt)) / 1000)}
                  </ToneBadge>
                ) : (
                  formatSpan((Date.parse(incident.endedAt) - Date.parse(incident.startedAt)) / 1000)
                )}
              </Table.Td>
              <Table.Td>{incident.detail}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

function IncidentsSection() {
  const incidents = useSystemIncidents();
  const nowMs = useNow(5000);
  return (
    <Section
      title="Feed incidents"
      description="The last 30, newest first. An incident that is still going on says so."
    >
      <QueryBoundary query={incidents} what="the feed incidents">
        {({ items }) => <IncidentsTable incidents={items} nowMs={nowMs} />}
      </QueryBoundary>
    </Section>
  );
}

export function HealthTab() {
  return (
    <Stack gap="md">
      <EngineCard />
      <HealthSection />
      <LatencySection />
      <IncidentsSection />
    </Stack>
  );
}
