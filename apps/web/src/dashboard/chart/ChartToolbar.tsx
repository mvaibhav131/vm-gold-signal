import {
  Button,
  Checkbox,
  Group,
  Menu,
  Popover,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';

import { MAX_INDICATORS } from './chartPrefs';
import { CHART_TYPES, CHART_TYPE_LABELS, isChartType, type ChartType } from './chartTypes';
import { DRAWING_TOOLS, TOOL_LABELS, type DrawingTool } from './drawings';
import {
  INDICATORS,
  OVERLAY_INDICATORS,
  PANE_INDICATORS,
  type IndicatorId,
} from './indicatorSpecs';

export interface ChartToolbarProps {
  readonly chartType: ChartType;
  readonly onChartType: (type: ChartType) => void;
  readonly indicators: readonly IndicatorId[];
  readonly onToggleIndicator: (id: IndicatorId) => void;
  readonly tool: DrawingTool | null;
  readonly onTool: (tool: DrawingTool | null) => void;
  readonly drawingCount: number;
  readonly onUndoDrawing: () => void;
  readonly onClearDrawings: () => void;
  readonly fullscreen: boolean;
  readonly onFullscreen: (next: boolean) => void;
}

function IndicatorGroup(props: {
  readonly label: string;
  readonly ids: readonly IndicatorId[];
  readonly active: readonly IndicatorId[];
  readonly onToggle: (id: IndicatorId) => void;
}) {
  return (
    <Stack gap={6} role="group" aria-label={props.label}>
      <Text size="xs" fw={600} c="dimmed">
        {props.label}
      </Text>
      {props.ids.map((id) => (
        <Checkbox
          key={id}
          size="xs"
          label={INDICATORS[id].name}
          checked={props.active.includes(id)}
          onChange={() => {
            props.onToggle(id);
          }}
          data-testid={`indicator-choice-${id}`}
        />
      ))}
    </Stack>
  );
}

/** The controls over the chart: the type of the chart, the indicators, the drawing tools and the full screen. */
export function ChartToolbar(props: ChartToolbarProps) {
  const { tool, drawingCount } = props;
  return (
    <Group gap="xs" wrap="wrap" data-testid="chart-toolbar">
      <SegmentedControl
        size="xs"
        aria-label="Candle style"
        data={CHART_TYPES.map((value) => ({ value, label: CHART_TYPE_LABELS[value] }))}
        value={props.chartType}
        onChange={(value) => {
          if (isChartType(value)) props.onChartType(value);
        }}
        data-testid="chart-type"
      />

      <Popover width={240} position="bottom-start" shadow="md" trapFocus hideDetached={false}>
        <Popover.Target>
          <Button
            size="compact-sm"
            variant={props.indicators.length > 0 ? 'light' : 'default'}
            data-testid="indicators-button"
          >
            {props.indicators.length > 0
              ? `Indicators (${String(props.indicators.length)})`
              : 'Indicators'}
          </Button>
        </Popover.Target>
        <Popover.Dropdown data-testid="indicators-menu">
          <Stack gap="sm">
            <IndicatorGroup
              label="On the price"
              ids={OVERLAY_INDICATORS}
              active={props.indicators}
              onToggle={props.onToggleIndicator}
            />
            <IndicatorGroup
              label="In their own pane"
              ids={PANE_INDICATORS}
              active={props.indicators}
              onToggle={props.onToggleIndicator}
            />
            <Text size="xs" c="dimmed">
              Up to {MAX_INDICATORS}. The numbers come from the same code as the signals.
            </Text>
          </Stack>
        </Popover.Dropdown>
      </Popover>

      <Menu
        position="bottom-start"
        shadow="md"
        width={220}
        hideDetached={false}
        withInitialFocusPlaceholder={false}
        menuItemTabIndex={0}
      >
        <Menu.Target>
          <Button
            size="compact-sm"
            variant={tool === null ? 'default' : 'filled'}
            data-testid="draw-button"
          >
            {tool === null ? 'Draw' : `Draw: ${TOOL_LABELS[tool]}`}
          </Button>
        </Menu.Target>
        <Menu.Dropdown data-testid="draw-menu">
          {DRAWING_TOOLS.map((value) => (
            <Menu.Item
              key={value}
              onClick={() => {
                props.onTool(value);
              }}
              data-testid={`draw-${value}`}
            >
              {TOOL_LABELS[value]}
            </Menu.Item>
          ))}
          <Menu.Divider />
          {tool !== null && (
            <Menu.Item
              onClick={() => {
                props.onTool(null);
              }}
              data-testid="draw-stop"
            >
              Stop drawing
            </Menu.Item>
          )}
          <Menu.Item
            disabled={drawingCount === 0}
            onClick={props.onUndoDrawing}
            data-testid="draw-undo"
          >
            Undo the last drawing
          </Menu.Item>
          <Menu.Item
            color="red"
            disabled={drawingCount === 0}
            onClick={props.onClearDrawings}
            data-testid="draw-clear"
          >
            Clear all drawings
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Button
        size="compact-sm"
        variant="default"
        onClick={() => {
          props.onFullscreen(!props.fullscreen);
        }}
        data-testid="chart-fullscreen"
      >
        {props.fullscreen ? 'Exit full screen' : 'Full screen'}
      </Button>
    </Group>
  );
}
