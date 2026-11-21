import { Group, Stack, Text } from '@mantine/core';
import type { Evidence } from '@vmgs/contracts';
import { EVIDENCE_MIN_SAMPLE, breakEvenReading, breakEvenWinRate, oneWinIn } from '@vmgs/core';

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

/** What the first target needs to break even, against what this setup type has done (R3). Words, not a colour alone. */
function breakEvenText(evidence: Evidence, rewardR: number): { text: string; verdict: string } {
  const needed = breakEvenWinRate(rewardR);
  const target = `at TP1 (${rewardR.toFixed(1)}R, before costs)`;
  if (evidence.sampleLabel === 'INSUFFICIENT' || evidence.ci === null) {
    // below the minimum sample no percentage is shown anywhere (rule C6): the bar is said as a count
    return {
      text: `A setup must win 1 trade in ${oneWinIn(needed)} to break even ${target}.`,
      verdict: 'UNKNOWN',
    };
  }
  const bar = `${formatPercent(needed)} needed to break even ${target}`;
  const { verdict } = breakEvenReading(rewardR, evidence.ci);
  if (verdict === 'ABOVE') return { text: `Above the ${bar}.`, verdict };
  if (verdict === 'BELOW') {
    return {
      text: `Below the ${bar}: this setup type has not paid for its stops so far.`,
      verdict,
    };
  }
  return {
    text: `The ${bar} is inside the interval: not clearly above or below it yet.`,
    verdict,
  };
}

/**
 * The historical evidence of a setup type (02_Signal_Engine section 13). Below 30 resolved trades
 * there is no percentage anywhere, only the counts and the words "Insufficient evidence" (rule C6,
 * scenario E6). From 30 to 99 the numbers carry a "Low sample" label. With the reward of the first target
 * it also says what win rate that target needs to break even, and where the evidence stands against it.
 */
export function EvidenceBlock({ evidence, rewardR }: { evidence: Evidence; rewardR?: number }) {
  const source = `Source: ${scopeText(evidence.scope)}. Match: ${matchLevelText(evidence.level)}.`;
  const bar = rewardR !== undefined && rewardR > 0 ? breakEvenText(evidence, rewardR) : null;
  const barLine = bar !== null && (
    <Text size="sm" data-testid="evidence-break-even" data-verdict={bar.verdict}>
      {bar.text}
    </Text>
  );

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
        {barLine}
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
      {barLine}
      <Text size="xs" c="dimmed">
        {source} This is a historical frequency, not a guarantee.
      </Text>
    </Stack>
  );
}
