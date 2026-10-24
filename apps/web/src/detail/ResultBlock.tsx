import { Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { Outcome, SignalState } from '@vmgs/contracts';
import type { ReactNode } from 'react';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { formatPrice } from '../format/format';
import { exitReasonText, formatR, rClass, resultChip } from '../format/signal';
import { formatDuration } from '../format/time';

function Figure({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} component="div" data-testid={testId}>
        {children}
      </Text>
    </div>
  );
}

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

const NOT_COUNTED: Readonly<Record<string, string>> = {
  CANCELLED:
    'This signal was cancelled before it could be entered. It is not counted in the statistics.',
  DATA_INVALID:
    'The data was not good enough to follow this trade (a feed gap longer than 60 seconds). It is not counted in the statistics.',
};

/**
 * The result of a finished signal, or the working state of an open one (05_UI_Spec section 5.3).
 * A cancelled or data-invalid signal says so and that it stays out of the statistics.
 */
export function ResultBlock({
  outcome,
  state,
}: {
  outcome: Outcome | null;
  state: SignalState | null;
}) {
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-labelledby="detail-result-title"
      data-testid="detail-result"
    >
      <Stack gap="sm">
        <Title order={2} size="h4" id="detail-result-title">
          Result
        </Title>
        {outcome ? <Finished outcome={outcome} /> : <Open state={state} />}
      </Stack>
    </Paper>
  );
}

function Finished({ outcome }: { outcome: Outcome }) {
  const chip = resultChip(outcome.result, 'CLOSED');
  const note = NOT_COUNTED[outcome.result];
  return (
    <>
      <Group gap="sm" align="center">
        <ToneBadge tone={chip.tone} size="lg" data-testid="detail-result-badge">
          {chip.text}
        </ToneBadge>
        {outcome.realizedRNet !== null && (
          <Text
            fz={26}
            fw={700}
            lh={1}
            className={rClass(outcome.realizedRNet)}
            data-testid="detail-net-r"
          >
            {formatR(outcome.realizedRNet)}
          </Text>
        )}
        {outcome.ambiguous && (
          <ToneBadge
            tone="warning"
            data-testid="detail-ambiguous"
            title="Stop and target were both crossed in the same tick; the result is counted against the trade"
          >
            Ambiguous
          </ToneBadge>
        )}
      </Group>
      {note && (
        <Text size="sm" data-testid="detail-result-note">
          {note}
        </Text>
      )}
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
        <Figure label="Exit price" testId="detail-exit-price">
          {outcome.exitPrice === null ? '\u2013' : formatPrice(outcome.exitPrice)}
        </Figure>
        <Figure label="Exit reason" testId="detail-exit-reason">
          {exitReasonText(outcome.exitReason)}
        </Figure>
        <Figure label="Closed">
          <TimeText iso={outcome.closedAt} withDate />
        </Figure>
        <Figure label="Duration" testId="detail-duration">
          {formatDuration(outcome.durationS)}
        </Figure>
        <Figure label="Best point (MFE)" testId="detail-mfe">
          {outcome.mfeR === null ? '\u2013' : formatR(outcome.mfeR)}
        </Figure>
        <Figure label="Worst point (MAE)" testId="detail-mae">
          {outcome.maeR === null ? '\u2013' : formatR(outcome.maeR)}
        </Figure>
        <Figure label="TP1 reached" testId="detail-tp1-reached">
          {yesNo(outcome.tp1Hit)}
        </Figure>
        <Figure label="TP2 reached" testId="detail-tp2-reached">
          {yesNo(outcome.tp2Hit)}
        </Figure>
        <Figure label="Cost" testId="detail-cost">
          {formatR(outcome.costR)}
        </Figure>
      </SimpleGrid>
    </>
  );
}

function Open({ state }: { state: SignalState | null }) {
  return (
    <>
      <Group gap="sm" align="center">
        <ToneBadge tone="info" size="lg" data-testid="detail-result-badge">
          {state?.status === 'TP1_HIT' ? 'Open (TP1 hit)' : 'Open'}
        </ToneBadge>
        <Text size="sm" c="dimmed">
          No result yet. The numbers below are the working state of the trade.
        </Text>
      </Group>
      {state && (
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
          <Figure label="Current stop" testId="detail-current-stop">
            {formatPrice(state.stopLossCurrent)}
          </Figure>
          <Figure label="Best point (MFE)">{formatR(state.mfeR)}</Figure>
          <Figure label="Worst point (MAE)">{formatR(state.maeR)}</Figure>
          <Figure label="TP1 reached at">
            {state.tp1HitAt === null ? 'not yet' : <TimeText iso={state.tp1HitAt} withDate />}
          </Figure>
          <Figure label="Updated">
            <TimeText iso={state.updatedAt} />
          </Figure>
        </SimpleGrid>
      )}
    </>
  );
}
