import { Alert, Group, Progress, Stack, Table, Text } from '@mantine/core';
import type { SystemStorage } from '@vmgs/contracts';

import { Bar, QueryBoundary, ScrollBox, Section } from '../components/page';
import { TimeText } from '../components/TimeText';
import { useSystemHealth, useSystemStorage } from '../data/queries';
import { formatSpan } from '../format/time';
import { useNow } from '../hooks';
import { budgetLevel, formatBytes, type BudgetLevel } from './health';

const BUDGET_TEXT: Readonly<Record<BudgetLevel, string>> = {
  OK: 'Within the budget',
  FILLING: 'Getting full',
  FULL: 'Over the soft limit',
};
const BUDGET_COLOR: Readonly<Record<BudgetLevel, string>> = {
  OK: 'positive',
  FILLING: 'warning',
  FULL: 'negative',
};

/** The size of the database against its budget. The words say what the bar says. */
export function BudgetGauge({ pct }: { pct: number }) {
  const level = budgetLevel(pct);
  return (
    <Stack gap={6} data-testid="storage-budget">
      <Group gap="sm">
        <Text fw={700}>{String(Math.round(pct))}% of the budget</Text>
        <Text size="sm" data-testid="storage-budget-level">
          {BUDGET_TEXT[level]}
        </Text>
      </Group>
      <Progress
        value={Math.min(100, pct)}
        color={BUDGET_COLOR[level]}
        aria-label={`Database size: ${String(Math.round(pct))}% of the budget`}
        size="lg"
      />
      {level !== 'OK' && (
        <Alert
          variant="light"
          color={level === 'FULL' ? 'negative' : 'warning'}
          role="note"
          title="The database is filling up"
          data-testid="storage-warning"
        >
          From 80% the maintenance job shortens the tick retention and sends a warning on Telegram,
          so the database stays below its limit. Signals, events and outcomes are never deleted.
        </Alert>
      )}
    </Stack>
  );
}

export function StorageView({
  storage,
  backupAt,
  nowMs,
}: {
  storage: SystemStorage;
  backupAt: string | null;
  nowMs: number;
}) {
  const biggest = Math.max(1, ...storage.tables.map((table) => table.sizeBytes));
  const run = storage.lastMaintenanceRun;
  return (
    <Stack gap="md">
      <Section
        title="Size"
        description="The database against its soft limit of 10 GB (01_HLD, data retention)."
      >
        <Group gap="xl" align="flex-start">
          <div>
            <Text size="xs" c="dimmed">
              Database size
            </Text>
            <Text fw={700} fz="xl" data-testid="storage-db-size">
              {formatBytes(storage.dbSizeBytes)}
            </Text>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <BudgetGauge pct={storage.budgetPct} />
          </div>
        </Group>
      </Section>

      <Section title="Tables" description="The biggest first.">
        <ScrollBox label="Table sizes, scrolls sideways">
          <Table
            verticalSpacing={6}
            horizontalSpacing="xs"
            fz="sm"
            miw={420}
            data-testid="storage-tables"
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Table</Table.Th>
                <Table.Th ta="right">Size</Table.Th>
                <Table.Th>Share of the biggest</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {storage.tables.map((table) => (
                <Table.Tr key={table.name} data-testid={`storage-table-${table.name}`}>
                  <Table.Th scope="row" fw={600}>
                    {table.name}
                  </Table.Th>
                  <Table.Td ta="right">{formatBytes(table.sizeBytes)}</Table.Td>
                  <Table.Td miw={140}>
                    <Bar fraction={table.sizeBytes / biggest} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollBox>
      </Section>

      <Section
        title="Retention rules"
        description="How long each kind of data is kept. Read only: the rules are in the design, not a setting."
      >
        <ScrollBox label="Retention rules, scrolls sideways">
          <Table
            verticalSpacing={6}
            horizontalSpacing="xs"
            fz="sm"
            miw={520}
            data-testid="storage-retention"
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Data</Table.Th>
                <Table.Th>Kept</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {storage.retention.map((rule) => (
                <Table.Tr key={rule.item}>
                  <Table.Th scope="row" fw={600}>
                    {rule.item}
                  </Table.Th>
                  <Table.Td>{rule.rule}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollBox>
      </Section>

      <Section title="Maintenance and backup">
        <Stack gap={4}>
          <Text size="sm" data-testid="storage-maintenance">
            {run === null ? (
              'No maintenance run has been recorded yet.'
            ) : (
              <>
                Last maintenance run: <b>{run.job}</b>,{' '}
                {run.finishedAt === null ? (
                  'not finished'
                ) : (
                  <>
                    finished <TimeText iso={run.finishedAt} withDate /> (
                    {formatSpan((nowMs - Date.parse(run.finishedAt)) / 1000)} ago)
                  </>
                )}
                , {run.rowsDeleted.toLocaleString('en')} rows deleted.
              </>
            )}
          </Text>
          <Text size="sm" data-testid="storage-backup">
            {backupAt === null ? (
              'No backup has been recorded yet.'
            ) : (
              <>
                Last backup: <TimeText iso={backupAt} withDate /> (
                {formatSpan((nowMs - Date.parse(backupAt)) / 1000)} ago).
              </>
            )}
          </Text>
        </Stack>
      </Section>
    </Stack>
  );
}

export function StorageTab() {
  const storage = useSystemStorage();
  const health = useSystemHealth();
  const nowMs = useNow(15_000);
  return (
    <QueryBoundary query={storage} what="the storage">
      {(data) => (
        <StorageView storage={data} backupAt={health.data?.lastBackupAt ?? null} nowMs={nowMs} />
      )}
    </QueryBoundary>
  );
}
