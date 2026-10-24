import { SimpleGrid, Stack, Text, Paper } from '@mantine/core';
import type { OverviewResponse } from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';
import type { ReactNode } from 'react';

import { useAnalyticsOverview } from '../data/queries';
import { formatFactor, formatInterval, formatPercent, formatR, rClass } from '../format/signal';
import { DASH, QueryBoundary, SampleBadge, Section } from './parts';

function Kpi({
  name,
  label,
  note,
  small = false,
  children,
}: {
  name: string;
  label: string;
  note?: ReactNode;
  /** A word instead of a number: smaller, so that it fits the card. */
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <Paper withBorder p="sm" radius="md" data-testid={`kpi-${name}`}>
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text fw={700} fz={small ? 'md' : 'xl'} component="div">
          {children}
        </Text>
        {note !== undefined && (
          <Text size="xs" c="dimmed" component="div">
            {note}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** A hit rate (TP1, TP2): a percentage from 30 valid results, otherwise the words (rule C6). */
function HitRateKpi({
  name,
  label,
  rate,
  n,
}: {
  name: string;
  label: string;
  rate: number | null;
  n: number;
}) {
  return rate === null ? (
    <Kpi name={name} label={label} small note={`${String(n)} valid results; a percentage needs 30`}>
      Insufficient evidence
    </Kpi>
  ) : (
    <Kpi name={name} label={label} note={`of ${String(n)} valid results`}>
      {formatPercent(rate)}
    </Kpi>
  );
}

/** The nine numbers at the top of the page, exactly as `GET /analytics/overview` sent them. */
export function KpiGrid({ overview }: { overview: OverviewResponse }) {
  const n = overview.resolvedValid;
  return (
    <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
      <Kpi name="generated" label="Signals generated" note="Every signal of this scope">
        {String(overview.generated)}
      </Kpi>
      <Kpi
        name="tracked"
        label="Properly tracked"
        note={`Valid results. Cancelled ${String(overview.cancelled)} and data-invalid ${String(overview.dataInvalid)} are counted apart`}
      >
        {String(n)}
      </Kpi>
      {overview.winRate === null || overview.ci95 === null ? (
        <Kpi
          name="win-rate"
          label="Win rate"
          small
          note={`${String(n)} valid results; a percentage needs 30`}
        >
          Insufficient evidence
        </Kpi>
      ) : (
        <Kpi
          name="win-rate"
          label="Win rate"
          note={
            <>
              95% CI {formatInterval(overview.ci95)}, n = {n} <SampleBadge n={n} />
            </>
          }
        >
          {formatPercent(overview.winRate)}
        </Kpi>
      )}
      <Kpi name="net-r" label="Net R" note="Sum of all valid results, after costs">
        <span className={rClass(overview.netR)}>{formatR(overview.netR)}</span>
      </Kpi>
      <Kpi name="expectancy" label="Expectancy" note="Average net R per valid result">
        {overview.expectancyR === null ? (
          DASH
        ) : (
          <span className={rClass(overview.expectancyR)}>{formatR(overview.expectancyR)}</span>
        )}
      </Kpi>
      <Kpi name="profit-factor" label="Profit factor" note="R won divided by R lost">
        {overview.profitFactor === null ? DASH : formatFactor(overview.profitFactor)}
      </Kpi>
      <Kpi
        name="max-drawdown"
        label="Max drawdown"
        note="Deepest fall from a peak of the equity curve"
      >
        <span className={rClass(-overview.maxDrawdownR)}>{formatR(-overview.maxDrawdownR)}</span>
      </Kpi>
      <HitRateKpi name="tp1-rate" label="TP1 reached" rate={overview.tp1Rate} n={n} />
      <HitRateKpi name="tp2-rate" label="TP2 reached" rate={overview.tp2Rate} n={n} />
    </SimpleGrid>
  );
}

export function KpiCards({ scope }: { scope: StatsScope }) {
  const query = useAnalyticsOverview(scope);
  return (
    <Section
      title="Key numbers"
      description="A win means net R above zero after costs. A percentage is shown only from 30 valid results; below that you see the counts."
    >
      <QueryBoundary query={query} what="the key numbers">
        {(overview) => <KpiGrid overview={overview} />}
      </QueryBoundary>
    </Section>
  );
}
