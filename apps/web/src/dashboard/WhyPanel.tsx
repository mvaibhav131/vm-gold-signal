import { Accordion, Group, List, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Explanation } from '@vmgs/contracts';
import { QUALITY_GROUPS, type GroupState } from '@vmgs/core';

import { ToneBadge } from '../components/ToneBadge';
import type { Tone } from '../format/format';
import { GROUP_LABELS } from '../format/signal';
import { TimeText } from '../components/TimeText';

const STATE_TONE: Record<GroupState, Tone> = {
  STRONG: 'positive',
  OK: 'info',
  WEAK: 'warning',
  FAIL: 'negative',
  NA: 'neutral',
};

type Group = Explanation['groups'][number];
type Fact = Group['facts'][number];

function factText(fact: Fact): string {
  return `${fact.label}: ${String(fact.value)}`;
}

/**
 * "Why this signal" (05_UI_Spec section 4): one row per evidence group with a state chip and the
 * actual values behind it. A group the explanation lacks is shown as NA, never left out.
 * On a phone the rows start collapsed.
 */
export function WhyPanel({
  explanation,
  signalSeq,
}: {
  explanation: Explanation;
  signalSeq: number;
}) {
  const isPhone = useMediaQuery('(max-width: 47.99em)', undefined, {
    getInitialValueInEffect: false,
  });
  const byKey = new Map(explanation.groups.map((group) => [group.key, group]));

  return (
    <Stack gap="sm" data-testid={`signal-why-${String(signalSeq)}`}>
      <Text fw={600}>Why this signal</Text>
      <Accordion multiple variant="separated" radius="md" chevronPosition="left">
        {QUALITY_GROUPS.map((key) => {
          const group = byKey.get(key);
          const state: GroupState = group?.state ?? 'NA';
          const facts = group?.facts ?? [];
          return (
            <Accordion.Item key={key} value={key} data-testid={`signal-why-group-${key}`}>
              <Accordion.Control>
                <Group gap="xs" wrap="nowrap" justify="space-between">
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text fw={500} size="sm" style={{ flex: '0 0 auto' }}>
                      {GROUP_LABELS[key]}
                    </Text>
                    {!isPhone && facts[0] && (
                      <Text size="xs" c="dimmed" truncate>
                        {facts.map(factText).join(' \u00B7 ')}
                      </Text>
                    )}
                  </Group>
                  <ToneBadge tone={STATE_TONE[state]} data-testid={`signal-why-state-${key}`}>
                    {state}
                  </ToneBadge>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                {facts.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No data for this group.
                  </Text>
                ) : (
                  <List size="sm" spacing={2} listStyleType="disc">
                    {facts.map((fact) => (
                      <List.Item key={fact.label}>{factText(fact)}</List.Item>
                    ))}
                  </List>
                )}
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>

      {explanation.weak.length > 0 && (
        <div data-testid="signal-weak">
          <Text size="sm" fw={600}>
            Weak
          </Text>
          <List size="sm" spacing={2} listStyleType="disc">
            {explanation.weak.map((item) => (
              <List.Item key={item}>{item}</List.Item>
            ))}
          </List>
        </div>
      )}

      {explanation.researchOnly.length > 0 && (
        <div data-testid="signal-research">
          <Text size="sm" fw={600}>
            Research only (not used)
          </Text>
          <List size="sm" spacing={2} listStyleType="disc">
            {explanation.researchOnly.map((fact) => (
              <List.Item key={fact.label}>{factText(fact)}</List.Item>
            ))}
          </List>
        </div>
      )}

      <Text size="sm" data-testid="signal-macro">
        <b>Macro:</b>{' '}
        {explanation.macro.state === 'UNKNOWN'
          ? 'news feed unavailable'
          : explanation.macro.state === 'IN_WINDOW'
            ? 'inside a news window'
            : 'no high-impact USD event nearby'}
        {explanation.macro.next && (
          <>
            {' '}
            (next: {explanation.macro.next.name} at <TimeText iso={explanation.macro.next.at} />)
          </>
        )}
      </Text>

      <div data-testid="signal-news">
        <Text size="sm">
          <b>News (last 60 min):</b>{' '}
          {explanation.news.feed === 'UNAVAILABLE'
            ? 'headline feed unavailable'
            : explanation.news.headlines.length === 0
              ? 'no high-impact headline'
              : null}
        </Text>
        {explanation.news.headlines.length > 0 && (
          <List size="sm" spacing={2} listStyleType="disc">
            {explanation.news.headlines.map((headline) => (
              <List.Item key={headline.url}>
                {headline.title}{' '}
                <Text span size="xs" c="dimmed">
                  ({headline.sources.join(', ')})
                </Text>
              </List.Item>
            ))}
          </List>
        )}
      </div>
    </Stack>
  );
}
