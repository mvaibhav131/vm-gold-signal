import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import type { NewsStateResponse } from '@vmgs/contracts';
import { Link } from 'react-router';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useNewsState, useTopHeadlines } from '../data/queries';
import type { Tone } from '../format/format';
import { labelOf } from '../format/format';
import { formatCountdown } from '../format/time';
import { useNow } from '../hooks';

const NEWS_STATE: Record<NewsStateResponse['state'], { text: string; tone: Tone }> = {
  CLEAR: { text: 'CLEAR', tone: 'neutral' },
  IN_WINDOW: { text: 'IN WINDOW', tone: 'warning' },
  UNKNOWN: { text: 'UNKNOWN: news feed unavailable', tone: 'warning' },
};

const IMPACT_TONE: Record<string, Tone> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };

/**
 * Next macro event and the newest headlines (05_UI_Spec section 7). Wording stays factual: a
 * headline is never described as the cause of a move.
 */
export function EventsCard() {
  const state = useNewsState();
  const headlines = useTopHeadlines(3);
  const now = useNow(15_000);
  const news = state.data;
  const next = news?.next ?? null;
  const secondsToNext = next ? (Date.parse(next.scheduledAt) - now) / 1000 : 0;

  return (
    <Paper withBorder p="md" radius="md" className="dash-events" data-testid="events-card">
      <Stack gap="sm">
        <Group gap="xs" justify="space-between">
          <Text fw={700}>Events and headlines</Text>
          {news && (
            <ToneBadge tone={NEWS_STATE[news.state].tone} data-testid="news-state">
              {NEWS_STATE[news.state].text}
            </ToneBadge>
          )}
        </Group>

        {news?.state === 'UNKNOWN' ? (
          <Text size="sm" data-testid="news-next">
            The calendar feed is unavailable. This is not the same as "no event".
          </Text>
        ) : next ? (
          <Text size="sm" data-testid="news-next">
            Next: <b>{next.name}</b> at <TimeText iso={next.scheduledAt} />{' '}
            {secondsToNext > 0 ? `(in ${formatCountdown(secondsToNext)})` : '(now)'}
          </Text>
        ) : (
          <Text size="sm" data-testid="news-next">
            No high-impact event is scheduled.
          </Text>
        )}

        <div data-testid="news-headlines">
          {headlines.isSuccess && headlines.data.items.length === 0 && (
            <Text size="sm" c="dimmed">
              No headline in the last hours.
            </Text>
          )}
          <Stack gap="sm">
            {headlines.data?.items.map((item) => (
              <div key={item.id} data-testid={`headline-${item.id}`}>
                <Group gap={6} mb={2}>
                  <ToneBadge tone={IMPACT_TONE[item.impact] ?? 'neutral'} size="sm">
                    {item.impact}
                  </ToneBadge>
                  {item.topics.map((topic) => (
                    <ToneBadge key={topic} tone="neutral" size="sm">
                      {labelOf(topic)}
                    </ToneBadge>
                  ))}
                </Group>
                <Anchor href={item.url} target="_blank" rel="noopener noreferrer" size="sm">
                  {item.title}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {item.sources.map((source) => source.name).join(', ')}
                  {item.publishedAt ? (
                    <>
                      {' · '}
                      <TimeText iso={item.publishedAt} />
                    </>
                  ) : null}
                  {item.delayS === null
                    ? ''
                    : ` · seen ${formatCountdown(item.delayS)} after publishing`}
                </Text>
              </div>
            ))}
          </Stack>
        </div>
        <Anchor component={Link} to="/news" size="sm">
          News and macro
        </Anchor>
      </Stack>
    </Paper>
  );
}
