import { Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import type { Autopsy, Outcome } from '@vmgs/contracts';
import { causeCategory } from '@vmgs/core';

import { ToneBadge } from '../components/ToneBadge';
import {
  CATEGORY_LABELS,
  CATEGORY_TONE,
  CAUSE_LABELS,
  CAUSE_RULES,
  GROUP_LABELS,
  humanizeKey,
} from '../format/signal';

type Counterfactual = NonNullable<Autopsy['counterfactual']>;

const REVIEWED_RESULTS = new Set(['PARTIAL_WIN', 'LOSS', 'TIME_EXIT']);

/** Why there is no review, when there is none. */
function noReviewText(outcome: Outcome | null): string {
  if (outcome === null) return 'The review runs when the signal closes.';
  if (outcome.result === 'WIN')
    return 'A full win is not reviewed: only partial wins, losses and time exits are.';
  if (!REVIEWED_RESULTS.has(outcome.result))
    return 'A cancelled or data-invalid signal has no review.';
  return 'The review has not been computed yet.';
}

function valueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

/** The numbers behind a cause, as `max favourable R 0.18, limit R 0.3`. */
function EvidenceNumbers({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return null;
  return (
    <Text size="xs" c="dimmed">
      {entries.map(([key, value]) => `${humanizeKey(key)} ${valueText(value)}`).join(', ')}
    </Text>
  );
}

function counterfactualText(c: Counterfactual): string[] {
  const lines = [
    c.reachedTp1
      ? `Price reached TP1 ${String(c.candlesToTp1 ?? 0)} candles (5m) after the close.`
      : 'Price did not reach TP1 in the hour after the close.',
  ];
  if (c.reachedTp2 !== undefined) {
    lines.push(
      c.reachedTp2
        ? `Price reached TP2 ${String(c.candlesToTp2 ?? 0)} candles (5m) after the close.`
        : 'Price did not reach TP2 in the hour after the close.',
    );
  }
  return lines;
}

/**
 * The automatic review of a signal that did not win outright (05_UI_Spec section 5.8): status,
 * primary cause with its category, supporting causes with numbers, the groups that were weak at
 * entry and the counterfactual. It is an attribution by rules, not a proof of cause.
 */
export function ReviewBlock({
  autopsy,
  outcome,
}: {
  autopsy: Autopsy | null;
  outcome: Outcome | null;
}) {
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-labelledby="detail-autopsy-title"
      data-testid="detail-autopsy"
    >
      <Stack gap="sm">
        <Group gap="sm" align="center">
          <Title order={2} size="h4" id="detail-autopsy-title">
            Review
          </Title>
          {autopsy && (
            <ToneBadge
              tone={autopsy.status === 'FINAL' ? 'positive' : 'warning'}
              data-testid="detail-autopsy-status"
            >
              {autopsy.status}
            </ToneBadge>
          )}
        </Group>

        {autopsy === null ? (
          <Text size="sm" c="dimmed" data-testid="detail-autopsy-none">
            {noReviewText(outcome)}
          </Text>
        ) : (
          <Body autopsy={autopsy} />
        )}

        <Text size="xs" c="dimmed">
          Heuristic attribution; judge strategy by the statistics in Analytics.
        </Text>
      </Stack>
    </Paper>
  );
}

function Body({ autopsy }: { autopsy: Autopsy }) {
  const primary = autopsy.causes.find((cause) => cause.code === autopsy.primaryCause);
  const supporting = autopsy.causes.filter((cause) => cause.code !== autopsy.primaryCause);
  const category = causeCategory(autopsy.primaryCause);
  return (
    <>
      {autopsy.status === 'PRELIMINARY' && (
        <Text size="sm" data-testid="detail-autopsy-pending">
          This is the preliminary review made at the close. The final review follows 60 minutes
          later, once price after the close has been observed.
        </Text>
      )}

      <div>
        <Text size="xs" c="dimmed">
          Primary cause
        </Text>
        <Group gap="xs" align="center">
          <Text fw={700} data-testid="detail-autopsy-cause">
            {CAUSE_LABELS[autopsy.primaryCause]}
          </Text>
          <ToneBadge tone={CATEGORY_TONE[category]} data-testid="detail-autopsy-category">
            {CATEGORY_LABELS[category]}
          </ToneBadge>
        </Group>
        <Text size="sm">{CAUSE_RULES[autopsy.primaryCause]}</Text>
        {primary && <EvidenceNumbers evidence={primary.evidence} />}
      </div>

      {supporting.length > 0 && (
        <div data-testid="detail-autopsy-supporting">
          <Text size="sm" fw={600}>
            Supporting causes
          </Text>
          <List size="sm" spacing={2} listStyleType="disc">
            {supporting.map((cause) => (
              <List.Item key={cause.code}>
                {CAUSE_LABELS[cause.code]}
                <EvidenceNumbers evidence={cause.evidence} />
              </List.Item>
            ))}
          </List>
        </div>
      )}

      <div data-testid="detail-autopsy-weak">
        <Text size="sm" fw={600}>
          Weak at entry
        </Text>
        {autopsy.weakGroupsAtEntry.length === 0 ? (
          <Text size="sm" c="dimmed">
            No evidence group was weak when the signal was taken.
          </Text>
        ) : (
          <Group gap="xs" mt={4}>
            {autopsy.weakGroupsAtEntry.map((weak) => (
              <ToneBadge key={weak.group} tone={weak.state === 'FAIL' ? 'negative' : 'warning'}>
                {GROUP_LABELS[weak.group]}: {weak.state}
              </ToneBadge>
            ))}
          </Group>
        )}
      </div>

      <div data-testid="detail-autopsy-counterfactual">
        <Text size="sm" fw={600}>
          What price did next
        </Text>
        {autopsy.counterfactual === null ? (
          <Text size="sm" c="dimmed">
            Not known yet: price is observed for 60 minutes after the close and shown in the final
            review.
          </Text>
        ) : (
          counterfactualText(autopsy.counterfactual).map((line) => (
            <Text size="sm" key={line}>
              {line}
            </Text>
          ))
        )}
      </div>
    </>
  );
}
