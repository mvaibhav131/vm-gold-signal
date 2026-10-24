import { Accordion, Code, Group, Paper, ScrollArea, Stack, Switch, Text } from '@mantine/core';
import type { StrategyInfo } from '@vmgs/contracts';
import { useState } from 'react';

import { QueryBoundary } from '../components/page';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useUpdateStrategy } from '../data/mutations';
import { useStrategies, useStrategyConfig } from '../data/queries';
import { STRATEGY_LABELS } from '../format/signal';
import { STATUS_LABELS, STATUS_TONE, evidenceLine } from './strategies';

function ConfigView({ strategy, opened }: { strategy: StrategyInfo; opened: boolean }) {
  const query = useStrategyConfig(strategy.key, opened);
  return (
    <QueryBoundary query={query} what="the config">
      {(data) => (
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Version {data.version}. A strategy version never changes: a different setting is a new
            version. In this preview the config is made up.
          </Text>
          <ScrollArea.Autosize
            mah={360}
            type="auto"
            viewportProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': `Config of ${STRATEGY_LABELS[strategy.key]}`,
            }}
          >
            <Code block data-testid={`strategy-config-${strategy.key}`}>
              {JSON.stringify(data.config, null, 2)}
            </Code>
          </ScrollArea.Autosize>
        </Stack>
      )}
    </QueryBoundary>
  );
}

/** One strategy: its status, the two switches, the newest signal and its evidence, and its config on request. */
export function StrategyCard({
  strategy,
  onEnabled,
  onAlerts,
}: {
  strategy: StrategyInfo;
  onEnabled: (enabled: boolean) => void;
  onAlerts: (alerts: boolean) => void;
}) {
  const [configOpened, setConfigOpened] = useState(false);
  const name = STRATEGY_LABELS[strategy.key];
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="article"
      data-testid={`strategy-row-${strategy.key}`}
    >
      <Stack gap="sm">
        <Group gap="sm" justify="space-between" align="flex-start">
          <Group gap="sm">
            <Text fw={700} component="h3" m={0}>
              {name}
            </Text>
            <Text size="xs" c="dimmed">
              {strategy.key} · version {strategy.version}
            </Text>
          </Group>
          <ToneBadge
            tone={STATUS_TONE[strategy.status]}
            data-testid={`strategy-status-${strategy.key}`}
          >
            {STATUS_LABELS[strategy.status]}
          </ToneBadge>
        </Group>

        <Group gap="xl">
          <Switch
            label="Enabled"
            aria-label={`Enabled: ${name}`}
            checked={strategy.enabled}
            onChange={(event) => {
              onEnabled(event.currentTarget.checked);
            }}
            data-testid={`strategy-enabled-${strategy.key}`}
          />
          <Switch
            label="Alerts"
            aria-label={`Alerts: ${name}`}
            checked={strategy.alerts}
            onChange={(event) => {
              onAlerts(event.currentTarget.checked);
            }}
            data-testid={`strategy-alerts-${strategy.key}`}
          />
        </Group>

        <Text size="sm" data-testid={`strategy-last-${strategy.key}`}>
          Last signal:{' '}
          {strategy.lastSignalAt === null ? (
            'none yet'
          ) : (
            <TimeText iso={strategy.lastSignalAt} withDate />
          )}
        </Text>
        <Text size="sm" data-testid={`strategy-evidence-${strategy.key}`}>
          Evidence: {evidenceLine(strategy.evidence)}
        </Text>

        <Accordion
          variant="contained"
          radius="md"
          value={configOpened ? 'config' : null}
          onChange={(value) => {
            setConfigOpened(value === 'config');
          }}
        >
          <Accordion.Item value="config">
            <Accordion.Control>Configuration (read only)</Accordion.Control>
            <Accordion.Panel>
              <ConfigView strategy={strategy} opened={configOpened} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Paper>
  );
}

export function StrategiesTab() {
  const strategies = useStrategies();
  const update = useUpdateStrategy();
  const [disabling, setDisabling] = useState<StrategyInfo | null>(null);
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed" maw={820}>
        A strategy that is switched off stops producing new signals; signals that are already open
        keep being tracked. The alert switch only decides whether a signal is sent to you. The
        status of a strategy is earned from its results, not set by hand.
      </Text>
      {update.isError && (
        <Text role="alert" className="text-negative" size="sm">
          The change could not be saved. Nothing was changed.
        </Text>
      )}
      <QueryBoundary query={strategies} what="the strategies">
        {(items) => (
          <Stack gap="md">
            {items.map((strategy) => (
              <StrategyCard
                key={strategy.key}
                strategy={strategy}
                onEnabled={(enabled) => {
                  if (enabled) update.mutate({ key: strategy.key, patch: { enabled: true } });
                  else setDisabling(strategy);
                }}
                onAlerts={(alerts) => {
                  update.mutate({ key: strategy.key, patch: { alerts } });
                }}
              />
            ))}
          </Stack>
        )}
      </QueryBoundary>
      <ConfirmDialog
        opened={disabling !== null}
        title={`Switch off ${disabling ? STRATEGY_LABELS[disabling.key] : ''}?`}
        confirmLabel="Switch off"
        testId="strategy-disable-confirm"
        loading={update.isPending}
        onClose={() => {
          setDisabling(null);
        }}
        onConfirm={() => {
          if (!disabling) return;
          update.mutate(
            { key: disabling.key, patch: { enabled: false } },
            {
              onSettled: () => {
                setDisabling(null);
              },
            },
          );
        }}
      >
        It stops producing new signals. Signals that are already open keep being tracked, and the
        results stay in the statistics. You can switch it on again at any time.
      </ConfirmDialog>
    </Stack>
  );
}
