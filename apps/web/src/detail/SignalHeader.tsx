import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import type { Signal } from '@vmgs/contracts';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { labelOf, modeChip } from '../format/format';
import { STRATEGY_LABELS, formatScore, signalLabel } from '../format/signal';

/** The header of the detail page: id, side, strategy and version, status of the strategy, mode and time (05_UI_Spec section 5.1). */
export function SignalHeader({ signal }: { signal: Signal }) {
  const mode = modeChip(signal.mode);
  const forwardTest = signal.warnings.includes('UNVALIDATED_STRATEGY');
  const buy = signal.side === 'BUY';
  return (
    <Paper withBorder p="md" radius="md" data-testid="detail-header">
      <Stack gap="xs">
        <Group gap="sm" wrap="wrap" align="center">
          <Text fw={700} fz="xl" data-testid="detail-id">
            {signalLabel(signal.seq)}
          </Text>
          <Badge color={buy ? 'positive' : 'negative'} variant="filled" data-testid="detail-side">
            {signal.side}
          </Badge>
          <Text c="dimmed" data-testid="detail-strategy">
            {STRATEGY_LABELS[signal.strategyKey]} v{signal.strategyVersion}
          </Text>
          <ToneBadge
            tone={forwardTest ? 'brand' : 'positive'}
            data-testid="detail-strategy-status"
            title={
              forwardTest
                ? 'This strategy had not been validated when the signal was produced (paper signal)'
                : undefined
            }
          >
            {forwardTest ? 'FORWARD-TEST' : 'VALIDATED'}
          </ToneBadge>
          <ToneBadge tone={mode.tone} data-testid="detail-mode">
            {mode.text}
          </ToneBadge>
          <ToneBadge tone="brand" data-testid="detail-grade">
            {signal.explanation.quality.grade} {formatScore(signal.qualityScore)}
          </ToneBadge>
        </Group>
        <Text size="sm">
          Generated <TimeText iso={signal.generatedAt} withDate />
          <Text span c="dimmed">
            {' '}
            · {labelOf(signal.session)} session · regime {labelOf(signal.regime)} · volatility{' '}
            {signal.volBucket.toLowerCase()}
          </Text>
        </Text>
        {signal.explanation.warnings.length > 0 && (
          <Group gap="xs" data-testid="detail-warnings">
            {signal.explanation.warnings.map((warning) => (
              <ToneBadge key={warning.code} tone="warning" title={warning.text}>
                {warning.code === 'UNVALIDATED_STRATEGY' ? 'FORWARD-TEST (paper)' : warning.text}
              </ToneBadge>
            ))}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
