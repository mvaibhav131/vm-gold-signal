import { Group, Stack, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import type { EquityPoint } from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';
import { useId, useMemo } from 'react';

import { useDisplayTz, useEquity } from '../data/queries';
import { formatR, rClass } from '../format/signal';
import { formatDateTime } from '../format/time';
import { equityGeometry, type PlotBox } from './equityGeometry';
import { QueryBoundary, SampleBadge, Section } from './parts';

const HEIGHT = 260;
/** Used until the real width is measured, and in tests where nothing has a width. */
const FALLBACK_WIDTH = 640;
const MARGIN = { left: 44, right: 14, top: 12, bottom: 12 } as const;

/**
 * The cumulative net R after each valid result, drawn as a plain SVG line (a chart library would
 * add more weight than this screen needs). The shaded area is the fall from the highest point so
 * far. The numbers under the chart say the same in words.
 */
export function EquityChart({
  points,
  timeZone,
}: {
  points: readonly EquityPoint[];
  timeZone: string;
}) {
  const titleId = useId();
  const { ref, width } = useElementSize();
  const drawWidth = width > 0 ? width : FALLBACK_WIDTH;
  const geometry = useMemo(() => {
    const box: PlotBox = { width: drawWidth, height: HEIGHT, ...MARGIN };
    return equityGeometry(points, box);
  }, [points, drawWidth]);

  const first = points[0];
  const last = points.at(-1);
  if (!geometry || !first || !last) {
    return (
      <Text size="sm" c="dimmed" data-testid="equity-curve">
        No valid results in this scope yet, so there is no curve.
      </Text>
    );
  }
  return (
    <Stack gap="xs" data-testid="equity-curve">
      <div ref={ref}>
        <svg
          width={drawWidth}
          height={HEIGHT}
          role="img"
          aria-labelledby={titleId}
          focusable="false"
          style={{ display: 'block', maxWidth: '100%' }}
        >
          <title id={titleId}>
            {`Equity curve in R: cumulative net R after each of ${String(points.length)} valid results, ending at ${formatR(geometry.final)}`}
          </title>
          {geometry.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={MARGIN.left}
                x2={drawWidth - MARGIN.right}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                strokeOpacity={tick.value === 0 ? 0.55 : 0.15}
                strokeDasharray={tick.value === 0 ? undefined : '3 4'}
              />
              <text
                x={MARGIN.left - 6}
                y={tick.y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize="11"
                fill="currentColor"
                fillOpacity={0.75}
              >
                {tick.value}
              </text>
            </g>
          ))}
          <path d={geometry.drawdown} fill="var(--vm-text-negative)" fillOpacity={0.22} />
          <path
            d={geometry.line}
            fill="none"
            stroke="var(--vm-brand)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <circle cx={geometry.last.x} cy={geometry.last.y} r={3.5} fill="var(--vm-brand)" />
        </svg>
      </div>
      <Group gap="md" align="center">
        <Text size="sm" data-testid="equity-summary">
          {points.length} valid results. Now{' '}
          <span className={rClass(geometry.final)}>{formatR(geometry.final)}</span>, highest{' '}
          {formatR(geometry.highest)}, lowest {formatR(geometry.lowest)}.
        </Text>
        <SampleBadge n={points.length} />
      </Group>
      <Text size="xs" c="dimmed">
        Left to right: the valid results in the order they closed, from{' '}
        {formatDateTime(first.t, timeZone)} to {formatDateTime(last.t, timeZone)}. The shaded area
        is the fall from the highest point so far; the deepest fall is the max drawdown in the key
        numbers. With a small sample the shape of the curve says little.
      </Text>
    </Stack>
  );
}

export function EquitySection({ scope }: { scope: StatsScope }) {
  const query = useEquity(scope);
  const timeZone = useDisplayTz();
  return (
    <Section
      title="Equity curve"
      description="Cumulative net R, in R multiples (1R is the risk of one signal)."
    >
      <QueryBoundary query={query} what="the equity curve">
        {({ items }) => <EquityChart points={items} timeZone={timeZone} />}
      </QueryBoundary>
    </Section>
  );
}
