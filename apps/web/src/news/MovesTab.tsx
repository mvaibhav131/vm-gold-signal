import { Anchor, Group, List, Paper, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import type { MarketMove } from '@vmgs/contracts';

import { QueryBoundary } from '../components/page';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useMarketMoves } from '../data/queries';
import { formatSpread } from '../format/format';
import { IMPACT_LABELS, IMPACT_TONE, TOPIC_LABELS } from '../format/news';
import { formatSpan } from '../format/time';
import { atrBasis, rankPossibleCauses, signedMoveUsd, windowLabel } from './moves';

/** The text for a move that no headline matches. It never guesses. */
export const NO_MATCH_TEXT =
  'No matching headline found in the free feeds. The move may be technical, flow-driven, or the news may not be in these feeds yet.';

/**
 * One sudden move of gold with the headlines that were visible in the 30 minutes before it (a
 * frozen copy). The wording is "possible cause, not confirmed": a headline near a move is not
 * proof that it moved the price.
 */
export function MoveCard({ move }: { move: MarketMove }) {
  const up = move.kind === 'SPIKE_UP';
  const detectedMs = Date.parse(move.detectedAt);
  const causes = rankPossibleCauses(move.headlines);
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="article"
      data-testid={`move-${String(move.id)}`}
    >
      <Stack gap="sm">
        <Group gap="sm" justify="space-between" align="flex-start">
          <Group gap="sm">
            <ToneBadge tone={up ? 'positive' : 'negative'}>
              {up ? 'Spike up' : 'Spike down'}
            </ToneBadge>
            <Text fw={700}>
              {signedMoveUsd(move.kind, move.moveUsd)} in {windowLabel(move.windowS)}
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            <TimeText iso={move.detectedAt} withDate />
          </Text>
        </Group>
        <Text size="sm">
          {move.moveAtr.toFixed(1)} × ATR({atrBasis(move.windowS)}) · spread{' '}
          {move.spread === null ? 'not recorded' : formatSpread(move.spread)}
        </Text>

        {causes.length === 0 ? (
          <Text size="sm" data-testid={`move-${String(move.id)}-none`}>
            {NO_MATCH_TEXT}
          </Text>
        ) : (
          <Stack gap={4}>
            <Title order={4} size="h6">
              Possible causes, not confirmed
            </Title>
            <Text size="xs" c="dimmed">
              Headlines of the 30 minutes before the move, by impact.
            </Text>
            <List type="ordered" spacing="xs" size="sm">
              {causes.map((headline) => (
                <List.Item key={headline.url}>
                  <Stack gap={2}>
                    <Group gap={6}>
                      {headline.impact === null ? (
                        <ToneBadge tone="neutral" size="sm">
                          Unclassified, timing only
                        </ToneBadge>
                      ) : (
                        <ToneBadge tone={IMPACT_TONE[headline.impact]} size="sm">
                          {IMPACT_LABELS[headline.impact]} impact
                        </ToneBadge>
                      )}
                      {headline.topics.map((topic) => (
                        <ToneBadge key={topic} tone="neutral" size="sm">
                          {TOPIC_LABELS[topic]}
                        </ToneBadge>
                      ))}
                    </Group>
                    <Anchor href={headline.url} target="_blank" rel="noopener noreferrer" size="sm">
                      {headline.title}
                      <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {headline.sources.join(', ')}
                      {headline.publishedAt === null ? (
                        ' · publish time not known'
                      ) : (
                        <>
                          {' · '}
                          <TimeText iso={headline.publishedAt} /> (
                          {formatSpan((detectedMs - Date.parse(headline.publishedAt)) / 1000)}{' '}
                          before the move)
                        </>
                      )}
                    </Text>
                  </Stack>
                </List.Item>
              ))}
            </List>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

export function MovesTab() {
  const query = useMarketMoves({});
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed" maw={820}>
        Moves of gold of at least 2.0 × ATR(5m) within 5 minutes, or 3.0 × ATR(1m) within 1 minute,
        of the last 30 days. They are information only: a move never creates or blocks a signal.
      </Text>
      <QueryBoundary query={query} what="the market moves">
        {({ items }) =>
          items.length === 0 ? (
            <Text size="sm" c="dimmed" data-testid="news-moves">
              No sudden move has been detected in the last 30 days.
            </Text>
          ) : (
            <Stack gap="md" data-testid="news-moves">
              {items.map((move) => (
                <MoveCard key={move.id} move={move} />
              ))}
              <Text size="xs" c="dimmed">
                This is context, not a signal. A headline that appears here was only visible near
                the move; it is not known to have moved the price.
              </Text>
            </Stack>
          )
        }
      </QueryBoundary>
    </Stack>
  );
}
