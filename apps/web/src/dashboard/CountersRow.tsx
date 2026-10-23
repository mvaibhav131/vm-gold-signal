import { Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '@vmgs/contracts';
import { addCivilDays, zonedParts, zonedWallTimeToUtc } from '@vmgs/core';
import { useMemo } from 'react';

import { useApi } from '../api/context';
import { KEYS, useDisplayTz, useSnapshot } from '../data/queries';
import { formatInterval, formatPercent, formatR } from '../format/signal';
import { useNow } from '../hooks';

/** Start of today and of tomorrow, and of this month and next month, in the display time zone (UTC instants). */
function periods(timeZone: string, nowMs: number) {
  const today = zonedParts(nowMs, timeZone);
  const at = (date: { year: number; month: number; day: number }) =>
    new Date(zonedWallTimeToUtc(date, 0, 0, timeZone)).toISOString();
  const monthStart = { year: today.year, month: today.month, day: 1 };
  const nextMonth =
    today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
  return {
    today: { from: at(today), to: at(addCivilDays(today, 1)) },
    month: { from: at(monthStart), to: at(nextMonth) },
  };
}

function Stat({ label, children, testId }: { label: string; children: string; testId?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} data-testid={testId}>
        {children}
      </Text>
    </div>
  );
}

function winRateText(overview: OverviewResponse): string {
  // A percentage only from 30 valid results (rule C6); below that the counts speak.
  if (overview.winRate === null || overview.ci95 === null) {
    return `Insufficient evidence (${String(overview.resolvedValid)} results)`;
  }
  return `${formatPercent(overview.winRate)} (95% CI ${formatInterval(overview.ci95)})`;
}

/** TODAY and MONTH counters (05_UI_Spec section 4). "Properly tracked" means resolvedValid. */
export function CountersRow() {
  const api = useApi();
  const timeZone = useDisplayTz();
  const snapshot = useSnapshot();
  // Refreshed hourly, so the periods follow the clock without changing the query keys all the time.
  const now = useNow(3_600_000);
  const range = useMemo(() => periods(timeZone, now), [timeZone, now]);
  const today = useQuery({
    queryKey: [...KEYS.overviewToday, range.today.from],
    queryFn: () => api.getOverview(range.today),
    refetchInterval: 60_000,
  });
  const month = useQuery({
    queryKey: [...KEYS.overviewMonth, range.month.from],
    queryFn: () => api.getOverview(range.month),
    refetchInterval: 60_000,
  });

  return (
    <section aria-label="Today and this month" className="dash-counters" data-testid="counters">
      <Group align="stretch" gap="md" grow preventGrowOverflow={false} wrap="wrap">
        <Paper withBorder p="md" radius="md" data-testid="counters-today" miw={260}>
          <Stack gap="xs">
            <Text fw={700}>Today</Text>
            {today.data ? (
              <Group gap="lg">
                <Stat label="Generated">{String(today.data.generated)}</Stat>
                <Stat label="Open">{String(snapshot.data?.engine.openCount ?? 0)}</Stat>
                <Stat label="Wins">{String(today.data.wins)}</Stat>
                <Stat label="Losses">{String(today.data.losses)}</Stat>
                <Stat label="Net" testId="today-net-r">
                  {formatR(today.data.netR)}
                </Stat>
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                Loading…
              </Text>
            )}
          </Stack>
        </Paper>
        <Paper withBorder p="md" radius="md" data-testid="counters-month" miw={260}>
          <Stack gap="xs">
            <Text fw={700}>This month</Text>
            {month.data ? (
              <>
                <Group gap="lg">
                  <Stat label="Generated">{String(month.data.generated)}</Stat>
                  <Stat label="Properly tracked">{String(month.data.resolvedValid)}</Stat>
                  <Stat label="Net" testId="month-net-r">
                    {formatR(month.data.netR)}
                  </Stat>
                </Group>
                <Text size="sm" data-testid="month-win-rate">
                  Win rate: {winRateText(month.data)}
                </Text>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                Loading…
              </Text>
            )}
          </Stack>
        </Paper>
      </Group>
    </section>
  );
}
