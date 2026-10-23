import { Paper, Stack, Text } from '@mantine/core';

import { TimeText } from '../components/TimeText';
import { useSnapshot } from '../data/queries';
import { WaitReasons } from './StateCards';

/** "Why no signal now" (05_UI_Spec section 4): the engine's own reasons, from the API, in plain words. */
export function WhyNoSignalCard() {
  const snapshot = useSnapshot();
  const engine = snapshot.data?.engine;
  const reasons = engine?.waitReasons ?? [];

  return (
    <Paper withBorder p="md" radius="md" className="dash-why-no" data-testid="why-no-signal">
      <Stack gap="sm">
        <Text fw={700}>Why no new signal now</Text>
        {!engine && (
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        )}
        {reasons.length > 0 && <WaitReasons reasons={reasons} testId="engine-reasons" />}
        {engine && reasons.length === 0 && (
          <Text size="sm">The engine is watching the market and has nothing to report.</Text>
        )}
        {engine && (
          <Text size="xs" c="dimmed">
            Checked at <TimeText iso={engine.evaluatedAt} />. The engine looks again when a 5-minute
            candle closes.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
