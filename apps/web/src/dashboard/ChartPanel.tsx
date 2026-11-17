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
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '../api/context';
import { KEYS, useDisplayTz, useOpenSignals, useQuote, useSnapshot } from '../data/queries';
import { formatPrice, midOf } from '../format/format';
import { signalLabel } from '../format/signal';
import { ChartToolbar } from './chart/ChartToolbar';
import {
  PREFS_KEY,
  parsePrefs,
  readStored,
  serializePrefs,
  toggleIndicator,
  writeStored,
  type ChartPrefs,
} from './chart/chartPrefs';
import type { ChartType } from './chart/chartTypes';
import {
  DRAWINGS_KEY,
  newDrawingId,
  parseDrawings,
  serializeDrawings,
  withDrawing,
  type Drawing,
  type DrawingTool,
  type NewDrawing,
} from './chart/drawings';
import { candleRefetchDelayMs, serverClockOffsetMs } from './chart/forming';
import type { IndicatorId } from './chart/indicatorSpecs';
import type { ChartSignal, LiveTick } from './chart/PriceChart';

const PriceChart = lazy(() => import('./chart/PriceChart'));

const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

/** How many closed candles the chart holds: room to scroll and zoom out far (the API allows 2000). */
const CANDLE_LIMIT = 600;

/** How many of the newest candles the first view shows, and "Reset" goes back to. */
const INITIAL_BARS: Readonly<Record<Timeframe, number>> = {
  '1m': 120,
  '5m': 120,
  '15m': 96,
  '1h': 72,
  '4h': 60,
  '1d': 60,
};

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

const CHART_WORD: Readonly<Record<ChartType, string>> = {
  candles: 'candlestick',
  heikin: 'Heikin Ashi',
  line: 'line',
};

function ChartBody() {
  const api = useApi();
  const timeZone = useDisplayTz();
  const scheme = useComputedColorScheme('dark');
  const quote = useQuote();
  const snapshot = useSnapshot();
  const open = useOpenSignals();
  const [tf, setTf] = useState<Timeframe>('5m');
  const [shown, setShown] = useState<string[]>(DEFAULT_SHOWN);
  // What the owner chose (indicators, type of chart) and drew stays in this browser.
  const [prefs, setPrefs] = useState<ChartPrefs>(() => parsePrefs(readStored(PREFS_KEY)));
  const [drawings, setDrawings] = useState<Drawing[]>(() =>
    parseDrawings(readStored(DRAWINGS_KEY)),
  );
  const [tool, setTool] = useState<DrawingTool | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const changePrefs = useCallback((next: ChartPrefs) => {
    setPrefs(next);
    writeStored(PREFS_KEY, serializePrefs(next));
  }, []);
  const toggle = useCallback(
    (id: IndicatorId) => {
      changePrefs({ ...prefs, indicators: toggleIndicator(prefs.indicators, id) });
    },
    [prefs, changePrefs],
  );
  const changeType = useCallback(
    (chartType: ChartType) => {
      changePrefs({ ...prefs, chartType });
    },
    [prefs, changePrefs],
  );
  const changeDrawings = useCallback((next: Drawing[]) => {
    setDrawings(next);
    writeStored(DRAWINGS_KEY, serializeDrawings(next));
  }, []);
  const addDrawing = useCallback(
    (drawing: NewDrawing) => {
      changeDrawings(withDrawing(drawings, drawing, newDrawingId()));
    },
    [drawings, changeDrawings],
  );
  const undoDrawing = useCallback(() => {
    changeDrawings(drawings.slice(0, -1));
  }, [drawings, changeDrawings]);
  const clearDrawings = useCallback(() => {
    changeDrawings([]);
  }, [changeDrawings]);

  // Full screen is the card laid over the whole window (not the browser's own full screen: that is missing on iPhones).
  // Escape puts it away, unless a drawing tool is on: then Escape drops the tool first.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && tool === null) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen, tool]);

  const query = useMemo<CandlesQuery>(
    () => ({
      tf,
      limit: CANDLE_LIMIT,
      overlays: shown.filter((name) => OVERLAY_NAMES.has(name)).join(','),
      objects: shown.filter((name) => !OVERLAY_NAMES.has(name) && name !== 'levels').join(','),
    }),
    [tf, shown],
  );
  const candles = useQuery({
    queryKey: [...KEYS.candles, query],
    queryFn: () => api.getCandles(query),
    // A candle is stored a moment after it closes: ask again just after the next close (the candle that is forming now is
    // drawn from the quote stream meanwhile).
    refetchInterval: () => candleRefetchDelayMs(tf, Date.now()),
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

  // The newest quote builds the candle that is forming (only while the feed is live: a stale price is not a candle).
  const tick = useMemo<LiveTick | null>(
    () =>
      quote?.feedState === 'LIVE'
        ? { price: midOf(quote.bid, quote.ask), ageMs: quote.ageMs }
        : null,
    [quote],
  );
  // The quotes carry no time of their own: this PC's clock is corrected by the server's (from the snapshot).
  const clockOffsetMs = serverClockOffsetMs(snapshot.data, snapshot.dataUpdatedAt);

  return (
    <Stack
      gap="sm"
      data-testid="chart-panel"
      className={fullscreen ? 'chart-body chart-body-full' : 'chart-body'}
      data-fullscreen={fullscreen ? 'true' : 'false'}
    >
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
        <ChartToolbar
          chartType={prefs.chartType}
          onChartType={changeType}
          indicators={prefs.indicators}
          onToggleIndicator={toggle}
          tool={tool}
          onTool={setTool}
          drawingCount={drawings.length}
          onUndoDrawing={undoDrawing}
          onClearDrawings={clearDrawings}
          fullscreen={fullscreen}
          onFullscreen={setFullscreen}
        />
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
            ? `XAUUSD ${tf} ${CHART_WORD[prefs.chartType]} chart. Last close ${formatPrice(last.c)}. ${String(data?.candles.length ?? 0)} candles.`
            : data
              ? `XAUUSD ${tf} ${CHART_WORD[prefs.chartType]} chart, no candles yet`
              : `XAUUSD ${CHART_WORD[prefs.chartType]} chart, loading`
        }
      >
        {data ? (
          <Suspense fallback={<Skeleton height="100%" radius="md" />}>
            <PriceChart
              key={`${tf}-${prefs.chartType}`}
              tf={tf}
              candles={data.candles}
              overlays={data.overlays}
              levels={showLevels ? data.levels : []}
              objects={data.objects}
              signals={signals}
              livePrice={livePrice}
              tick={tick}
              clockOffsetMs={clockOffsetMs}
              initialBars={INITIAL_BARS[tf]}
              scheme={scheme}
              timeZone={timeZone}
              chartType={prefs.chartType}
              indicators={prefs.indicators}
              onRemoveIndicator={toggle}
              tool={tool}
              drawings={drawings}
              onDrawingAdd={addDrawing}
              onToolChange={setTool}
            />
          </Suspense>
        ) : (
          <Skeleton height="100%" radius="md" />
        )}
      </div>

      {data?.candles.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="chart-empty">
          No {tf} candles have been recorded yet. The chart fills as the worker records the market.
        </Text>
      )}

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
