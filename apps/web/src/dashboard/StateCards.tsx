import { Button, Group, Paper, Progress, Stack, Text } from '@mantine/core';
import type { MarketSnapshot } from '@vmgs/contracts';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { formatPrice } from '../format/format';

type Engine = MarketSnapshot['engine'];

/** The reasons the engine gives for not producing a signal, in plain words, exactly as the API sends them. */
export function WaitReasons({
  reasons,
  testId,
}: {
  reasons: Engine['waitReasons'];
  testId: string;
}) {
  return (
    <Group gap="xs" data-testid={testId} role="list" aria-label="Reasons">
      {reasons.map((reason) => (
        <ToneBadge
          key={reason.code}
          tone="warning"
          size="lg"
          data-testid={`wait-reason-${reason.code}`}
          // Badge text is white space nowrap by default; reasons can be long on a phone.
          styles={{ label: { whiteSpace: 'normal', textTransform: 'none' } }}
          role="listitem"
        >
          {reason.label}
        </ToneBadge>
      ))}
    </Group>
  );
}

/** WAIT: no open signal, so the card says why (05_UI_Spec section 4). */
export function WaitCard({ engine }: { engine: Engine }) {
  return (
    <Paper withBorder p="md" radius="md" data-testid="wait-card">
      <Stack gap="sm">
        <Group gap="xs">
          <Text fw={700}>No signal</Text>
          <ToneBadge tone="neutral">WAIT</ToneBadge>
        </Group>
        {engine.waitReasons.length === 0 ? (
          <Text size="sm" c="dimmed">
            The engine is watching the market. No setup meets the rules yet.
          </Text>
        ) : (
          <WaitReasons reasons={engine.waitReasons} testId="wait-reasons" />
        )}
        <Text size="xs" c="dimmed">
          A signal is only produced when every blocking check passes. Waiting is a normal state.
        </Text>
      </Stack>
    </Paper>
  );
}

/** WARMING_UP: a progress bar and the timeframes that still miss candles. No signals are possible yet. */
export function WarmingUpCard({ engine }: { engine: Engine }) {
  const { progressPct, missingTimeframes } = engine.warmup;
  return (
    <Paper withBorder p="md" radius="md" data-testid="warming-up">
      <Stack gap="sm">
        <Group gap="xs">
          <Text fw={700}>Warming up</Text>
          <ToneBadge tone="warning">{Math.round(progressPct)}%</ToneBadge>
        </Group>
        <Progress
          value={progressPct}
          color="warning"
          aria-label="Warm-up progress"
          data-testid="warmup-progress"
        />
        <Group gap="xs" data-testid="warmup-missing">
          <Text size="sm">Still missing candles on:</Text>
          {missingTimeframes.map((tf) => (
            <ToneBadge key={tf} tone="warning">
              {tf}
            </ToneBadge>
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          No signal is possible until every timeframe has enough history for its indicators.
        </Text>
      </Stack>
    </Paper>
  );
}

/** MARKET_CLOSED: grey, with the last price and when it was seen. */
export function MarketClosedCard({ snapshot }: { snapshot: MarketSnapshot }) {
  return (
    <Paper withBorder p="md" radius="md" data-testid="market-closed">
      <Stack gap="xs">
        <Group gap="xs">
          <Text fw={700}>Market closed</Text>
          <ToneBadge tone="neutral">MARKET CLOSED</ToneBadge>
        </Group>
        <Text size="sm">
          Last price {formatPrice(snapshot.mid)} at <TimeText iso={snapshot.sourceAt} withDate />.
        </Text>
        <Text size="xs" c="dimmed">
          No alerts are sent while the market is closed. The system stays up.
        </Text>
      </Stack>
    </Paper>
  );
}

/** PAUSED: amber, paused by the owner, with a Resume button. The system never pauses itself. */
export function PausedCard({
  engine,
  onResume,
  resuming,
}: {
  engine: Engine;
  onResume: () => void;
  resuming: boolean;
}) {
  return (
    <Paper withBorder p="md" radius="md" data-testid="paused-card" className="paused-card">
      <Stack gap="sm">
        <Group gap="xs" justify="space-between">
          <Group gap="xs">
            <Text fw={700}>Engine paused</Text>
            <ToneBadge tone="warning">PAUSED</ToneBadge>
          </Group>
          <Button size="sm" loading={resuming} onClick={onResume} data-testid="resume-button">
            Resume
          </Button>
        </Group>
        <Text size="sm">
          You paused the engine
          {engine.pausedSince ? (
            <>
              {' '}
              at <TimeText iso={engine.pausedSince} withDate />
            </>
          ) : null}
          . No new signals are produced and no signal alerts are sent. Data is still recorded and
          open signals are still tracked.
        </Text>
      </Stack>
    </Paper>
  );
}
