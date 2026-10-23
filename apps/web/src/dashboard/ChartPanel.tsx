import {
  Accordion,
  Chip,
  Group,
  Paper,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  useComputedColorScheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import type { CandlesQuery } from '@vmgs/contracts';
import type { Timeframe } from '@vmgs/core';
import { Suspense, lazy, useMemo, useState } from 'react';

import { useApi } from '../api/context';
import { KEYS, useDisplayTz, useOpenSignals, useQuote } from '../data/queries';
import { formatPrice, midOf } from '../format/format';
import { signalLabel } from '../format/signal';
import type { ChartSignal } from './chart/PriceChart';

const PriceChart = lazy(() => import('./chart/PriceChart'));

const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

const OVERLAY_CHOICES = [
  { value: 'ema20', label: 'EMA 20' },
  { value: 'ema50', label: 'EMA 50' },
  { value: 'ema200', label: 'EMA 200' },
  { value: 'supertrend', label: 'Supertrend' },
] as const;

const OBJECT_CHOICES = [
  { value: 'levels', label: 'Levels' },
  { value: 'trendlines', label: 'Trendlines' },
  { value: 'zones', label: 'Zones' },
  { value: 'patterns', label: 'Patterns' },
  { value: 'fib', label: 'Fibonacci' },
] as const;

const DEFAULT_SHOWN = ['ema20', 'ema50', 'ema200', 'levels', 'trendlines', 'zones'];
const OVERLAY_NAMES = new Set<string>(OVERLAY_CHOICES.map((c) => c.value));

function ChartBody() {
  const api = useApi();
  const timeZone = useDisplayTz();
  const scheme = useComputedColorScheme('dark');
  const quote = useQuote();
  const open = useOpenSignals();
  const [tf, setTf] = useState<Timeframe>('5m');
  const [shown, setShown] = useState<string[]>(DEFAULT_SHOWN);

  const query = useMemo<CandlesQuery>(
    () => ({
      tf,
      limit: 200,
      overlays: shown.filter((name) => OVERLAY_NAMES.has(name)).join(','),
      objects: shown.filter((name) => !OVERLAY_NAMES.has(name) && name !== 'levels').join(','),
    }),
    [tf, shown],
  );
  const candles = useQuery({
    queryKey: [...KEYS.candles, query],
    queryFn: () => api.getCandles(query),
    // A closed candle appears at most once a minute; the live price comes from the quote stream.
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });

  const signals = useMemo<ChartSignal[]>(
    () =>
      (open.data?.items ?? []).map(({ signal }) => ({
        label: signalLabel(signal.seq),
        side: signal.side,
        generatedAt: signal.generatedAt,
        entry: signal.entry,
        stop: signal.stopLoss,
        tp1: signal.tp1,
        tp2: signal.tp2,
      })),
    [open.data],
  );

  const data = candles.data;
  const last = data?.candles.at(-1);
  const showLevels = shown.includes('levels');
  const livePrice = quote ? midOf(quote.bid, quote.ask) : null;

  return (
    <Stack gap="sm" data-testid="chart-panel">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Group gap="xs">
          <Text fw={700}>XAUUSD</Text>
          <SegmentedControl
            size="xs"
            aria-label="Timeframe"
            data={TIMEFRAMES.map((value) => ({ value, label: value }))}
            value={tf}
            onChange={(value) => {
              setTf(value);
            }}
            data-testid="chart-timeframe"
          />
        </Group>
        <Text size="xs" c="dimmed">
          Mid price, closed candles
        </Text>
      </Group>

      <Chip.Group multiple value={shown} onChange={setShown}>
        <Group gap={6} role="group" aria-label="Chart overlays" data-testid="chart-overlays">
          {[...OVERLAY_CHOICES, ...OBJECT_CHOICES].map((choice) => (
            <Chip key={choice.value} value={choice.value} size="xs" variant="outline">
              {choice.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>

      <div
        className="chart-box"
        role="group"
        aria-label={
          last
            ? `XAUUSD ${tf} candlestick chart. Last close ${formatPrice(last.c)}. ${String(data?.candles.length ?? 0)} candles.`
            : 'XAUUSD candlestick chart, loading'
        }
      >
        {data ? (
          <Suspense fallback={<Skeleton height="100%" radius="md" />}>
            <PriceChart
              key={tf}
              tf={tf}
              candles={data.candles}
              overlays={data.overlays}
              levels={showLevels ? data.levels : []}
              objects={data.objects}
              signals={signals}
              livePrice={livePrice}
              scheme={scheme}
              timeZone={timeZone}
            />
          </Suspense>
        ) : (
          <Skeleton height="100%" radius="md" />
        )}
      </div>

      {/* The same information as text: readable without the picture, and what the tests check. */}
      {data && (
        <Stack gap={4}>
          <Group gap="md" data-testid="chart-legend">
            {Object.entries(data.overlays).map(([name, values]) => {
              const value = values.at(-1);
              return (
                <Text size="xs" key={name} data-testid={`legend-${name}`}>
                  {OVERLAY_CHOICES.find((c) => c.value === name)?.label ?? name}{' '}
                  {value === null || value === undefined ? '\u2013' : formatPrice(value)}
                </Text>
              );
            })}
          </Group>
          {showLevels && (
            <Group gap="md" data-testid="chart-levels">
              {data.levels
                .filter((level) => !level.key.startsWith('round-'))
                .map((level) => (
                  <Text size="xs" key={level.key} data-testid={`level-${level.key}`}>
                    {level.label} {formatPrice(level.price)}
                  </Text>
                ))}
            </Group>
          )}
        </Stack>
      )}
      {candles.isError && (
        <Text size="sm" role="alert" className="text-negative">
          Could not load the chart data. Retrying.
        </Text>
      )}
    </Stack>
  );
}

/**
 * The chart card. On a phone it starts collapsed (05_UI_Spec section 4), so the signals come
 * first and the chart is only built when it is opened.
 */
export function ChartPanel() {
  const isPhone = useMediaQuery('(max-width: 47.99em)', undefined, {
    getInitialValueInEffect: false,
  });
  const [opened, setOpened] = useState<string | null>(null);

  return (
    <section aria-label="Chart" className="dash-chart" data-testid="chart-section">
      {isPhone ? (
        <Accordion variant="separated" radius="md" value={opened} onChange={setOpened}>
          <Accordion.Item value="chart">
            <Accordion.Control>Chart</Accordion.Control>
            <Accordion.Panel>{opened === 'chart' && <ChartBody />}</Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      ) : (
        <Paper withBorder p="md" radius="md">
          <ChartBody />
        </Paper>
      )}
    </section>
  );
}
