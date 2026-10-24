import {
  Accordion,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import type { CandlesQuery, Outcome, Signal } from '@vmgs/contracts';
import { bucketStart } from '@vmgs/core';
import { Suspense, lazy, useMemo, useState } from 'react';

import { useApi } from '../api/context';
import type { ChartSignal } from '../dashboard/chart/PriceChart';
import { KEYS, useDisplayTz } from '../data/queries';
import { formatPrice } from '../format/format';
import { exitReasonText, signalLabel } from '../format/signal';

const PriceChart = lazy(() => import('../dashboard/chart/PriceChart'));

const CANDLE_MS = 300_000;
/** 60 candles of 5m before the signal and 60 after its exit (05_UI_Spec section 5.5). */
const CONTEXT_CANDLES = 60;

/** The label of the circle at the exit of the trade. */
function exitLabel(outcome: Outcome): string {
  switch (outcome.result) {
    case 'WIN':
      return 'TP2';
    case 'PARTIAL_WIN':
      return 'Stop at entry';
    case 'LOSS':
      return 'Stop';
    case 'TIME_EXIT':
      return 'Time exit';
    case 'CANCELLED':
      return 'Cancelled';
    case 'DATA_INVALID':
      return 'Data invalid';
  }
}

function ChartBody({ signal, outcome }: { signal: Signal; outcome: Outcome | null }) {
  const api = useApi();
  const timeZone = useDisplayTz();
  const scheme = useComputedColorScheme('dark');
  // Fixed while the page is open, so the candles are asked for once.
  const [openedAt] = useState(() => Date.now());

  const query = useMemo<CandlesQuery>(() => {
    if (outcome === null) return { tf: '5m', limit: 2 * CONTEXT_CANDLES };
    const generatedMs = Date.parse(signal.generatedAt);
    const closedMs = Date.parse(outcome.closedAt);
    const end = Math.min(openedAt, bucketStart('5m', closedMs) + (CONTEXT_CANDLES + 1) * CANDLE_MS);
    const tradeCandles = Math.ceil((closedMs - generatedMs) / CANDLE_MS) + 1;
    return {
      tf: '5m',
      limit: CONTEXT_CANDLES + tradeCandles + CONTEXT_CANDLES + 2,
      before: new Date(end).toISOString(),
    };
  }, [signal.generatedAt, outcome, openedAt]);

  const candles = useQuery({
    queryKey: [...KEYS.candles, 'trade', signal.id, query],
    queryFn: () => api.getCandles(query),
    // A finished trade does not change; an open one gets a new candle now and then.
    staleTime: outcome ? Infinity : 0,
    refetchInterval: outcome ? false : 30_000,
  });

  const chartSignals = useMemo<ChartSignal[]>(
    () => [
      {
        label: signalLabel(signal.seq),
        side: signal.side,
        generatedAt: signal.generatedAt,
        entry: signal.entry,
        stop: signal.stopLoss,
        tp1: signal.tp1,
        tp2: signal.tp2,
        ...(outcome ? { exit: { at: outcome.closedAt, label: exitLabel(outcome) } } : {}),
      },
    ],
    [signal, outcome],
  );

  const data = candles.data;
  return (
    <Stack gap="sm">
      <div
        className="chart-box"
        role="group"
        aria-label={`XAUUSD 5m candles around ${signalLabel(signal.seq)}. ${String(data?.candles.length ?? 0)} candles.`}
        data-testid="detail-chart"
      >
        {data ? (
          <Suspense fallback={<Skeleton height="100%" radius="md" />}>
            <PriceChart
              tf="5m"
              candles={data.candles}
              overlays={{}}
              levels={[]}
              objects={data.objects}
              signals={chartSignals}
              livePrice={null}
              scheme={scheme}
              timeZone={timeZone}
            />
          </Suspense>
        ) : (
          <Skeleton height="100%" radius="md" />
        )}
      </div>
      {/* The same information as text: readable without the picture, and what the tests check. */}
      <Text size="xs" data-testid="detail-chart-legend">
        {signalLabel(signal.seq)} {signal.side}: entry {formatPrice(signal.entry)}, stop{' '}
        {formatPrice(signal.stopLoss)}, TP1 {formatPrice(signal.tp1)}
        {signal.tp2 === null ? '' : `, TP2 ${formatPrice(signal.tp2)}`}
        {outcome
          ? `. Exit: ${exitLabel(outcome)}${outcome.exitPrice === null ? '' : ` at ${formatPrice(outcome.exitPrice)}`} (${exitReasonText(outcome.exitReason)}).`
          : '. Still open.'}{' '}
        {data ? `${String(data.candles.length)} candles of 5 minutes.` : ''}
      </Text>
      {candles.isError && (
        <Text size="sm" role="alert" className="text-negative">
          Could not load the candles around this trade.
        </Text>
      )}
    </Stack>
  );
}

/** The chart around the trade (05_UI_Spec section 5.5). On a phone it starts collapsed, like the dashboard chart. */
export function TradeChart({ signal, outcome }: { signal: Signal; outcome: Outcome | null }) {
  const isPhone = useMediaQuery('(max-width: 47.99em)', undefined, {
    getInitialValueInEffect: false,
  });
  const [opened, setOpened] = useState<string | null>(null);

  if (isPhone) {
    return (
      <section aria-label="Chart around the trade" data-testid="detail-chart-section">
        <Accordion variant="separated" radius="md" value={opened} onChange={setOpened}>
          <Accordion.Item value="chart">
            <Accordion.Control>Chart around the trade</Accordion.Control>
            <Accordion.Panel>
              {opened === 'chart' && <ChartBody signal={signal} outcome={outcome} />}
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </section>
    );
  }
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-labelledby="detail-chart-title"
      data-testid="detail-chart-section"
    >
      <Stack gap="sm">
        <Title order={2} size="h4" id="detail-chart-title">
          Chart around the trade
        </Title>
        <ChartBody signal={signal} outcome={outcome} />
      </Stack>
    </Paper>
  );
}
