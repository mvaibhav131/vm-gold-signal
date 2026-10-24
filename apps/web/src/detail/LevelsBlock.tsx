import { Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { Signal } from '@vmgs/contracts';
import type { ReactNode } from 'react';

import { TimeText } from '../components/TimeText';
import { formatPrice } from '../format/format';
import { EXIT_PROFILE_TEXT } from '../format/signal';

function Figure({
  label,
  testId,
  note,
  children,
}: {
  label: string;
  testId: string;
  note?: string | undefined;
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
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </div>
  );
}

/** The levels of the trade (05_UI_Spec section 5.2): entry, the limit for chasing, stop, targets, risk, exit profile and times. */
export function LevelsBlock({ signal }: { signal: Signal }) {
  return (
    <Paper withBorder p="md" radius="md" component="section" aria-labelledby="detail-levels-title">
      <Stack gap="sm">
        <Title order={2} size="h4" id="detail-levels-title">
          Levels
        </Title>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
          <Figure
            label="Entry"
            testId="detail-entry"
            note={`do not chase beyond ${formatPrice(signal.maxValidEntry)}`}
          >
            {formatPrice(signal.entry)}
          </Figure>
          <Figure label="Stop" testId="detail-stop">
            {formatPrice(signal.stopLoss)}
          </Figure>
          <Figure label="Risk" testId="detail-risk">
            {formatPrice(signal.riskDistance)} USD
          </Figure>
          <Figure label="TP1" testId="detail-tp1" note="1.0R">
            {formatPrice(signal.tp1)}
          </Figure>
          <Figure label="TP2" testId="detail-tp2" note={signal.tp2 === null ? undefined : '2.0R'}>
            {signal.tp2 === null ? '\u2013' : formatPrice(signal.tp2)}
          </Figure>
          <Figure label="ATR(5m)" testId="detail-atr">
            {formatPrice(signal.atr5)}
          </Figure>
        </SimpleGrid>
        <Text size="sm" data-testid="detail-exit-profile">
          <b>Exit profile:</b> {EXIT_PROFILE_TEXT[signal.exitProfile]}
        </Text>
        <Text size="sm" c="dimmed">
          Entry valid until <TimeText iso={signal.entryValidUntil} withDate />. Time stop at{' '}
          <TimeText iso={signal.timeStopAt} withDate />.
        </Text>
      </Stack>
    </Paper>
  );
}
