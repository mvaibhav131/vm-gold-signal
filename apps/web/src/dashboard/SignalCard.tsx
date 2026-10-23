import { Badge, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { OpenSignal } from '@vmgs/contracts';

import { ToneBadge } from '../components/ToneBadge';
import { formatPrice } from '../format/format';
import { STRATEGY_LABELS, formatR, formatScore, signalLabel } from '../format/signal';
import { formatCountdown } from '../format/time';
import { useNow } from '../hooks';
import type { Tone } from '../format/format';
import { EvidenceBlock } from './EvidenceBlock';
import { WhyPanel } from './WhyPanel';

/** The advisory flags as chips: short words, the full sentence in the tooltip. */
const WARNING_LABEL: Readonly<Record<string, string>> = {
  UNVALIDATED_STRATEGY: 'FORWARD-TEST (paper)',
};

function Level({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: number;
  note?: string;
  testId: string;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} data-testid={testId}>
        {formatPrice(value)}
      </Text>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </div>
  );
}

/** What the card says about the state of the trade, given the state of the data (05_UI_Spec section 4). */
function stateOf(
  status: OpenSignal['live']['status'],
  feedState: string | undefined,
): { text: string; tone: Tone; note?: string } {
  if (feedState === 'STALE') {
    return {
      text: 'DATA_STALE',
      tone: 'negative',
      note: 'This trade cannot be tracked until fresh data returns.',
    };
  }
  if (feedState === 'DISCONNECTED') {
    return {
      text: 'DISCONNECTED',
      tone: 'negative',
      note: 'This trade cannot be tracked while the feed is down.',
    };
  }
  return status === 'TP1_HIT'
    ? { text: 'TP1 HIT', tone: 'positive' }
    : { text: 'ACTIVE', tone: 'info' };
}

/**
 * One open signal: levels, live R, state, countdown to the time stop, warnings, why and evidence.
 * The numbers are exactly the ones the API sent; nothing is computed here except the countdown.
 */
export function SignalCard({
  item,
  feedState,
}: {
  item: OpenSignal;
  feedState: string | undefined;
}) {
  const { signal, live } = item;
  const now = useNow(15_000);
  const label = signalLabel(signal.seq);
  const state = stateOf(live.status, feedState);
  const secondsToStop = (Date.parse(signal.timeStopAt) - now) / 1000;
  const afterTp1 = live.status === 'TP1_HIT';
  const buy = signal.side === 'BUY';

  return (
    <Paper withBorder p="md" radius="md" data-testid={`signal-card-${String(signal.seq)}`}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="wrap">
            <Badge color={buy ? 'positive' : 'negative'} variant="filled" data-testid="signal-side">
              {signal.side}
            </Badge>
            <Text fw={700} data-testid="signal-id">
              {label}
            </Text>
            <Text size="sm" c="dimmed">
              {STRATEGY_LABELS[signal.strategyKey]} v{signal.strategyVersion}
            </Text>
          </Group>
          <ToneBadge tone="brand" data-testid="signal-grade">
            {signal.explanation.quality.grade} {formatScore(signal.qualityScore)}
          </ToneBadge>
        </Group>

        <Group gap="xs">
          <ToneBadge tone={state.tone} data-testid="signal-state">
            {state.text}
          </ToneBadge>
          {signal.explanation.warnings.map((warning) => (
            <ToneBadge
              key={warning.code}
              tone="warning"
              title={warning.text}
              data-testid={`signal-warning-${warning.code}`}
            >
              {WARNING_LABEL[warning.code] ?? warning.text}
            </ToneBadge>
          ))}
        </Group>
        {state.note && (
          <Text size="sm" className="text-negative" role="status">
            {state.note}
          </Text>
        )}

        <SimpleGrid cols={2} spacing="sm">
          <Level
            label="Entry"
            value={signal.entry}
            note={`do not chase beyond ${formatPrice(signal.maxValidEntry)}`}
            testId="signal-entry"
          />
          <Level
            label={afterTp1 ? 'Stop (break-even)' : 'Stop'}
            value={live.stopLossCurrent}
            note={`risk ${formatPrice(signal.riskDistance)} USD`}
            testId="signal-stop"
          />
          <Level
            label="TP1"
            value={signal.tp1}
            note={
              afterTp1
                ? 'reached: close 50%, stop moved to entry'
                : '1.0R: close 50%, move stop to entry'
            }
            testId="signal-tp1"
          />
          {signal.tp2 !== null && (
            <Level label="TP2" value={signal.tp2} note="2.0R" testId="signal-tp2" />
          )}
        </SimpleGrid>

        <Group justify="space-between" align="flex-end">
          <div>
            <Text size="xs" c="dimmed">
              Live
            </Text>
            <Text
              fz={28}
              fw={700}
              lh={1.1}
              className={rClass(live.unrealisedR)}
              data-testid="signal-live-r"
            >
              {formatR(live.unrealisedR)}
            </Text>
          </div>
          <Stack gap={0} align="flex-end">
            <Text size="sm">
              MFE {formatR(live.mfeR)} · MAE {formatR(live.maeR)}
            </Text>
            <Text size="sm" c="dimmed" data-testid="signal-time-stop">
              {secondsToStop > 0
                ? `Time stop in ${formatCountdown(secondsToStop)}`
                : 'Time stop reached'}
            </Text>
          </Stack>
        </Group>

        <WhyPanel explanation={signal.explanation} signalSeq={signal.seq} />
        <EvidenceBlock evidence={signal.evidence} />
      </Stack>
    </Paper>
  );
}

function rClass(value: number): string | undefined {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return undefined;
}
