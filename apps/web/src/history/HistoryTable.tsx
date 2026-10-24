import { Anchor, Badge, Group, Text } from '@mantine/core';
import type { SignalHistoryRow, SignalSort } from '@vmgs/contracts';
import { causeCategory, qualityGrade } from '@vmgs/core';
import { DataTable, type DataTableSortStatus } from 'mantine-datatable';
import 'mantine-datatable/styles.css';
import { Link, useNavigate } from 'react-router';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { formatPrice } from '../format/format';
import {
  CATEGORY_LABELS,
  CATEGORY_TONE,
  CAUSE_LABELS,
  STRATEGY_LABELS,
  formatPercent,
  formatR,
  formatScore,
  rClass,
  resultChip,
  signalLabel,
} from '../format/signal';
import { formatDuration } from '../format/time';

const SORTABLE: readonly SignalSort[] = [
  'generatedAt',
  'qualityScore',
  'realizedRNet',
  'durationS',
];

function isSort(accessor: string): accessor is SignalSort {
  return (SORTABLE as readonly string[]).includes(accessor);
}

/** What the signal said about its own track record when it was created (02_Signal_Engine section 13). */
function evidenceText(row: SignalHistoryRow): string {
  if (row.evidenceN === null) return '\u2013';
  if (row.evidenceWinRate === null) return `n=${String(row.evidenceN)} (insufficient)`;
  return `${formatPercent(row.evidenceWinRate)} \u00B7 n=${String(row.evidenceN)}`;
}

/**
 * The signal table of 05_UI_Spec section 6.1. Sorting is done by the API (the table only reports
 * the column), so it works across all pages and not only over the rows that are loaded.
 */
export function HistoryTable({
  rows,
  sort,
  order,
  onSort,
  fetching,
}: {
  rows: readonly SignalHistoryRow[];
  sort: SignalSort;
  order: 'asc' | 'desc';
  onSort: (sort: SignalSort, order: 'asc' | 'desc') => void;
  fetching: boolean;
}) {
  const navigate = useNavigate();
  const sortStatus: DataTableSortStatus<SignalHistoryRow> = {
    columnAccessor: sort,
    direction: order,
  };

  return (
    <div data-testid="history-table">
      <DataTable<SignalHistoryRow>
        records={[...rows]}
        idAccessor="signalId"
        withTableBorder
        highlightOnHover
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        minHeight={rows.length === 0 ? 140 : 0}
        fetching={fetching}
        noRecordsText="No signals match these filters."
        sortStatus={sortStatus}
        onSortStatusChange={(status) => {
          const accessor = String(status.columnAccessor);
          if (isSort(accessor)) onSort(accessor, status.direction);
        }}
        customRowAttributes={({ seq }) => ({ 'data-testid': `history-row-${String(seq)}` })}
        onRowClick={({ record }) => {
          void navigate(`/signals/${record.signalId}`);
        }}
        columns={[
          {
            accessor: 'generatedAt',
            title: 'Time',
            sortable: true,
            render: (row) => <TimeText iso={row.generatedAt} withDate />,
          },
          {
            accessor: 'seq',
            title: '#',
            render: (row) => (
              <Anchor
                component={Link}
                to={`/signals/${row.signalId}`}
                onClick={(event: { stopPropagation: () => void }) => {
                  event.stopPropagation();
                }}
              >
                {signalLabel(row.seq)}
              </Anchor>
            ),
          },
          {
            accessor: 'strategyKey',
            title: 'Strategy',
            render: (row) => (
              <span>
                {STRATEGY_LABELS[row.strategyKey]}{' '}
                <Text span size="xs" c="dimmed">
                  v{row.strategyVersion}
                </Text>
              </span>
            ),
          },
          {
            accessor: 'side',
            title: 'Side',
            render: (row) => (
              <Badge size="sm" variant="light" color={row.side === 'BUY' ? 'positive' : 'negative'}>
                {row.side}
              </Badge>
            ),
          },
          {
            accessor: 'qualityScore',
            title: 'Grade',
            sortable: true,
            render: (row) => (
              <span>
                {formatScore(row.qualityScore)}{' '}
                <Text span size="xs" c="dimmed">
                  {qualityGrade(row.qualityScore)}
                </Text>
              </span>
            ),
          },
          {
            accessor: 'entry',
            title: 'Entry',
            textAlign: 'right',
            render: (row) => formatPrice(row.entry),
          },
          {
            accessor: 'stopLoss',
            title: 'Stop',
            textAlign: 'right',
            render: (row) => formatPrice(row.stopLoss),
          },
          {
            accessor: 'tp1',
            title: 'TP1',
            textAlign: 'right',
            render: (row) => formatPrice(row.tp1),
          },
          {
            accessor: 'tp2',
            title: 'TP2',
            textAlign: 'right',
            render: (row) => (row.tp2 === null ? '\u2013' : formatPrice(row.tp2)),
          },
          {
            accessor: 'result',
            title: 'Result',
            render: (row) => {
              const chip = resultChip(row.result, row.state);
              return (
                <ToneBadge tone={chip.tone} size="sm">
                  {chip.text}
                </ToneBadge>
              );
            },
          },
          {
            accessor: 'realizedRNet',
            title: 'Net R',
            sortable: true,
            textAlign: 'right',
            render: (row) =>
              row.realizedRNet === null ? (
                '\u2013'
              ) : (
                <span className={rClass(row.realizedRNet)}>{formatR(row.realizedRNet)}</span>
              ),
          },
          {
            accessor: 'durationS',
            title: 'Duration',
            sortable: true,
            textAlign: 'right',
            render: (row) => (row.durationS === null ? '\u2013' : formatDuration(row.durationS)),
          },
          {
            accessor: 'primaryCause',
            title: 'Cause',
            render: (row) =>
              row.primaryCause === null ? (
                '\u2013'
              ) : (
                <Group gap={6} wrap="nowrap">
                  <span>{CAUSE_LABELS[row.primaryCause]}</span>
                  <ToneBadge tone={CATEGORY_TONE[causeCategory(row.primaryCause)]} size="xs">
                    {CATEGORY_LABELS[causeCategory(row.primaryCause)]}
                  </ToneBadge>
                  {row.autopsyStatus === 'PRELIMINARY' && (
                    <Text span size="xs" c="dimmed">
                      preliminary
                    </Text>
                  )}
                </Group>
              ),
          },
          { accessor: 'evidenceN', title: 'Evidence', render: (row) => evidenceText(row) },
        ]}
      />
    </div>
  );
}
