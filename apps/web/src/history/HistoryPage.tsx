import { Accordion, Alert, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';

import { useDisplayTz, useSignalHistory } from '../data/queries';
import { usePageTitle } from '../hooks';
import { HistoryFilterBar } from './HistoryFilterBar';
import { HistorySummary } from './HistorySummary';
import { HistoryTable } from './HistoryTable';
import { DEFAULT_SORT, filtersFromParams, withParam, withSort, withoutFilters } from './filters';

/** Signals are loaded 20 at a time; the next page comes with the "Load more" button (cursor pagination). */
const PAGE_SIZE = 20;

/** How long a change of the filters counts as "not yet in the address bar" (see `setParams`). */
const PENDING_MS = 1000;

/**
 * Signal history (`/signals`, 05_UI_Spec section 6.1): filters in the address bar, a summary of
 * the whole filtered list, a sortable table and cursor pagination.
 */
export default function HistoryPage() {
  usePageTitle('Signals');
  const timeZone = useDisplayTz();
  const [params, setSearchParams] = useSearchParams();
  const parsed = useMemo(() => filtersFromParams(params, timeZone), [params, timeZone]);
  const query = useSignalHistory(parsed.filters, PAGE_SIZE);
  const isPhone = useMediaQuery('(max-width: 47.99em)', undefined, {
    getInitialValueInEffect: false,
  });

  // The address bar of react-router is updated asynchronously and `setSearchParams(fn)` does not
  // queue like a React state setter: a change made before the previous one has reached the address
  // bar (two date fields filled one after the other) would start from the old address and the first
  // change would be lost. A change is therefore remembered for a second and the next one starts from it.
  const pending = useRef<{ params: URLSearchParams; at: number } | null>(null);
  const setParams = (change: (current: URLSearchParams) => URLSearchParams) => {
    const fresh = pending.current !== null && Date.now() - pending.current.at < PENDING_MS;
    const next = change(fresh && pending.current ? pending.current.params : params);
    pending.current = { params: next, at: Date.now() };
    setSearchParams(next, { replace: true });
  };

  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const summary = query.data?.pages[0]?.summary;
  const sort = parsed.filters.sort ?? DEFAULT_SORT.sort;
  const order = parsed.filters.order ?? DEFAULT_SORT.order;

  const filterBar = (
    <HistoryFilterBar
      parsed={parsed}
      onParam={(name, value) => {
        setParams((current) => withParam(current, name, value));
      }}
      onReset={() => {
        setParams(withoutFilters);
      }}
    />
  );

  return (
    <Stack gap="md" data-testid="page-signals">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Signals
        </Title>
        <Text c="dimmed" size="sm" maw={760}>
          Every signal with its result and, when it failed, the reason found by the automatic
          review. The review is a heuristic: judge the strategy by the statistics in Analytics.
        </Text>
      </Stack>

      {isPhone ? (
        <Accordion variant="separated" radius="md">
          <Accordion.Item value="filters">
            <Accordion.Control>
              Filters{parsed.active > 0 ? ` (${String(parsed.active)} active)` : ''}
            </Accordion.Control>
            <Accordion.Panel>{filterBar}</Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      ) : (
        <Paper withBorder p="md" radius="md">
          {filterBar}
        </Paper>
      )}

      <HistorySummary summary={summary} filtered={parsed.active > 0} />

      {query.isError && !query.data && (
        <Alert color="negative" role="alert" title="Could not load the signals">
          <Group gap="sm">
            <Text size="sm">Check the connection and try again.</Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          </Group>
        </Alert>
      )}

      {query.isPending ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : (
        <>
          <HistoryTable
            rows={rows}
            sort={sort}
            order={order}
            fetching={query.isFetching && !query.isFetchingNextPage}
            onSort={(nextSort, nextOrder) => {
              setParams((current) => withSort(current, nextSort, nextOrder));
            }}
          />
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed" role="status" data-testid="history-count">
              Showing {rows.length} of {summary?.generated ?? rows.length} signals
            </Text>
            {query.hasNextPage && (
              <Button
                variant="light"
                loading={query.isFetchingNextPage}
                onClick={() => {
                  void query.fetchNextPage();
                }}
                data-testid="history-load-more"
              >
                Load more
              </Button>
            )}
          </Group>
        </>
      )}
    </Stack>
  );
}
