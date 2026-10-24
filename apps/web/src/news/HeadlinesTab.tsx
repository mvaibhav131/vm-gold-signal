import {
  Alert,
  Anchor,
  Button,
  Group,
  List,
  Select,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import type { Headline, HeadlinesResponse } from '@vmgs/contracts';
import { NEWS_IMPACTS, NEWS_TOPICS, type NewsImpact, type NewsTopic } from '@vmgs/core';

import { QueryBoundary } from '../components/page';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useHeadlineFeed, type HeadlineFilters } from '../data/queries';
import { IMPACT_LABELS, IMPACT_TONE, TOPIC_LABELS, formatMove } from '../format/news';
import { formatSpan } from '../format/time';
import { useNow } from '../hooks';
import { headlineFeedStatus } from './feeds';

const ALL = 'all';
/** Headlines load 20 at a time with a "Load more" button (cursor pagination). */
const PAGE_SIZE = 20;

/** The banner that says the headline feeds are down, so that a short or empty list is never taken for "no news". */
export function HeadlineFeedBanner({
  sources,
  nowMs,
}: {
  sources: HeadlinesResponse['sources'];
  nowMs: number;
}) {
  const status = headlineFeedStatus(sources, nowMs);
  if (status.state === 'OK') return null;
  if (status.state === 'NONE') {
    return (
      <Alert
        variant="light"
        color="warning"
        role="status"
        title="No headline feed is switched on"
        data-testid="headline-feed-banner"
      >
        No headlines can arrive. This is not the same as no news.
      </Alert>
    );
  }
  const down = status.state === 'DOWN';
  return (
    <Alert
      variant="light"
      color="warning"
      role="status"
      title={down ? 'Headline feed unavailable' : 'Some headline feeds are unavailable'}
      data-testid="headline-feed-banner"
    >
      <Stack gap={6}>
        <Text size="sm">
          {down
            ? `None of the ${String(status.enabled)} headline feeds is working, so new headlines cannot be seen. A short or empty list is not the same as no news.`
            : `${String(status.problems.length)} of ${String(status.enabled)} headline feeds are not working. Headlines that only they carry may be missing.`}
        </Text>
        <List size="sm" spacing={2}>
          {status.problems.map(({ source, reason }) => (
            <List.Item key={source.key}>
              <b>{source.name}:</b> {reason}
            </List.Item>
          ))}
        </List>
      </Stack>
    </Alert>
  );
}

/** One clustered story: impact and topics, the headline with its link, the outlets, the delay and what gold did since. */
export function HeadlineRow({ headline }: { headline: Headline }) {
  return (
    <List.Item data-testid={`headline-${headline.id}`}>
      <Stack gap={4}>
        <Group gap={6}>
          <ToneBadge tone={IMPACT_TONE[headline.impact]} size="sm">
            {IMPACT_LABELS[headline.impact]} impact
          </ToneBadge>
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
          {headline.sources.map((source) => source.name).join(', ')}
          {' · '}
          {headline.publishedAt === null ? (
            'publish time not known'
          ) : (
            <>
              published <TimeText iso={headline.publishedAt} withDate />
            </>
          )}
          {' · '}
          {headline.delayS === null
            ? 'detection delay not known'
            : `seen ${formatSpan(headline.delayS)} after publishing`}
        </Text>
        <Text size="xs">
          Gold since publication:{' '}
          {headline.goldMoveSincePublish === null
            ? 'not measured'
            : formatMove(headline.goldMoveSincePublish)}
        </Text>
      </Stack>
    </List.Item>
  );
}

function Empty({ filtered, down }: { filtered: boolean; down: boolean }) {
  return (
    <Text size="sm" c="dimmed" data-testid="news-headlines">
      {down
        ? 'No headline to show. The feeds are unavailable, which is not the same as no news.'
        : filtered
          ? 'No headline matches these filters.'
          : 'No headline has been stored yet.'}
    </Text>
  );
}

export function HeadlinesTab({
  filters,
  onFilter,
}: {
  filters: { minImpact: NewsImpact | undefined; topic: NewsTopic | undefined };
  onFilter: (name: 'impact' | 'topic', value: string | undefined) => void;
}) {
  const apiFilters: HeadlineFilters = {
    ...(filters.minImpact === undefined ? {} : { minImpact: filters.minImpact }),
    ...(filters.topic === undefined ? {} : { topic: filters.topic }),
  };
  const query = useHeadlineFeed(apiFilters, PAGE_SIZE);
  const nowMs = useNow(15_000);
  const filtered = filters.minImpact !== undefined || filters.topic !== undefined;

  return (
    <Stack gap="md">
      <Group gap="md" align="flex-end">
        <Select
          label="Minimum impact"
          data={[
            { value: ALL, label: 'Any impact' },
            ...NEWS_IMPACTS.map((value) => ({ value, label: `${IMPACT_LABELS[value]} and above` })),
          ]}
          value={filters.minImpact ?? ALL}
          onChange={(value) => {
            onFilter('impact', value === ALL ? undefined : (value ?? undefined));
          }}
          allowDeselect={false}
          w={200}
          data-testid="news-filter-impact"
        />
        <Select
          label="Topic"
          data={[
            { value: ALL, label: 'All topics' },
            ...NEWS_TOPICS.map((value) => ({ value, label: TOPIC_LABELS[value] })),
          ]}
          value={filters.topic ?? ALL}
          onChange={(value) => {
            onFilter('topic', value === ALL ? undefined : (value ?? undefined));
          }}
          allowDeselect={false}
          maxDropdownHeight={380}
          w={260}
          data-testid="news-filter-topic"
        />
      </Group>

      <QueryBoundary query={query} what="the headlines">
        {(data) => {
          const items = data.pages.flatMap((page) => page.items);
          const sources = data.pages[0]?.sources ?? [];
          const status = headlineFeedStatus(sources, nowMs);
          return (
            <Stack gap="md">
              <HeadlineFeedBanner sources={sources} nowMs={nowMs} />
              {items.length === 0 ? (
                <Empty filtered={filtered} down={status.state === 'DOWN'} />
              ) : (
                <List listStyleType="none" spacing="md" data-testid="news-headlines">
                  {items.map((headline) => (
                    <HeadlineRow key={headline.id} headline={headline} />
                  ))}
                </List>
              )}
              <Group justify="space-between" align="center">
                <Text size="sm" c="dimmed" role="status" data-testid="headlines-count">
                  Showing {items.length} {items.length === 1 ? 'headline' : 'headlines'}
                </Text>
                {query.hasNextPage && (
                  <Button
                    variant="light"
                    loading={query.isFetchingNextPage}
                    onClick={() => {
                      void query.fetchNextPage();
                    }}
                    data-testid="headlines-load-more"
                  >
                    Load more
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                A headline is context, not a signal. The impact and the topics come from fixed
                rules, and the move of gold is measured, not explained: the system cannot say what
                moved the price.
              </Text>
            </Stack>
          );
        }}
      </QueryBoundary>
    </Stack>
  );
}
