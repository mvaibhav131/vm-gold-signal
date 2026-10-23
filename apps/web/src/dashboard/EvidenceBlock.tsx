import { Group, Stack, Text } from '@mantine/core';
import type { Evidence } from '@vmgs/contracts';
import { EVIDENCE_MIN_SAMPLE } from '@vmgs/core';

import { ToneBadge } from '../components/ToneBadge';
import {
  formatFactor,
  formatInterval,
  formatPercent,
  formatR,
  matchLevelText,
  scopeText,
} from '../format/signal';

function Figure({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} data-testid={testId}>
        {value}
      </Text>
    </div>
  );
}

/**
 * The historical evidence of a setup type (02_Signal_Engine section 13). Below 30 resolved trades
 * there is no percentage anywhere, only the counts and the words "Insufficient evidence" (rule C6,
 * scenario E6). From 30 to 99 the numbers carry a "Low sample" label.
 */
export function EvidenceBlock({ evidence }: { evidence: Evidence }) {
  const source = `Source: ${scopeText(evidence.scope)}. Match: ${matchLevelText(evidence.level)}.`;

  if (evidence.sampleLabel === 'INSUFFICIENT') {
    return (
      <Stack gap={6} data-testid="signal-evidence">
        <Group gap="xs">
          <Text fw={600}>Evidence</Text>
          <ToneBadge tone="warning">Insufficient evidence</ToneBadge>
        </Group>
        <Text size="sm" data-testid="evidence-n">
          {evidence.n} resolved trades of this setup type so far ({evidence.wins} wins). A win rate
          is shown from {EVIDENCE_MIN_SAMPLE} trades.
        </Text>
        <Text size="xs" c="dimmed">
          {source}
        </Text>
      </Stack>
    );
  }

  const { winRate, ci, expectancyR, profitFactor, tp1Rate, tp2Rate } = evidence;
  return (
    <Stack gap={8} data-testid="signal-evidence">
      <Group gap="xs">
        <Text fw={600}>Evidence (same setup type)</Text>
        {evidence.sampleLabel === 'LOW_SAMPLE' && <ToneBadge tone="warning">Low sample</ToneBadge>}
      </Group>
      <Group gap="lg" align="flex-start">
        <Figure
          label="Historical setup win rate"
          value={winRate === null ? '\u2013' : formatPercent(winRate)}
          testId="evidence-win-rate"
        />
        <Figure label="Sample" value={`n=${String(evidence.n)}`} testId="evidence-n" />
        <Figure
          label="95% CI"
          value={ci === null ? '\u2013' : formatInterval(ci)}
          testId="evidence-ci"
        />
        <Figure label="Expectancy" value={expectancyR === null ? '\u2013' : formatR(expectancyR)} />
        <Figure
          label="Profit factor"
          value={profitFactor === null ? '\u2013' : formatFactor(profitFactor)}
        />
      </Group>
      {(tp1Rate !== null || tp2Rate !== null) && (
        <Text size="sm">
          TP1 reached {tp1Rate === null ? '\u2013' : formatPercent(tp1Rate)}, TP2 reached{' '}
          {tp2Rate === null ? '\u2013' : formatPercent(tp2Rate)}.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {source} This is a historical frequency, not a guarantee.
      </Text>
    </Stack>
  );
}
