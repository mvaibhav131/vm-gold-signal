import { Stack, Tabs, Text, Title } from '@mantine/core';
import { MACRO_IMPORTANCE, NEWS_IMPACTS, NEWS_TOPICS, type MacroImportance } from '@vmgs/core';
import { useSearchParams } from 'react-router';

import { useNewsState, useSettings } from '../data/queries';
import { usePageTitle, useNow } from '../hooks';
import { CalendarTab } from './CalendarTab';
import { HeadlinesTab } from './HeadlinesTab';
import { MovesTab } from './MovesTab';
import { NewsStateCard } from './NewsStateCard';

const TABS = ['calendar', 'headlines', 'moves'] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABELS: Readonly<Record<TabKey, string>> = {
  calendar: 'Calendar',
  headlines: 'Headlines',
  moves: 'Market moves',
};

/** The tab and the filters are in the address, so a link opens the same view (a value that is not valid is ignored). */
export function newsViewFromParams(params: URLSearchParams) {
  const pick = <T extends string>(list: readonly T[], name: string): T | undefined =>
    list.find((value) => value === params.get(name));
  return {
    tab: pick(TABS, 'tab') ?? 'calendar',
    importance: pick(MACRO_IMPORTANCE, 'importance'),
    minImpact: pick(NEWS_IMPACTS, 'impact'),
    topic: pick(NEWS_TOPICS, 'topic'),
  };
}

/** Sets one parameter of the address; a value of undefined removes it. */
export function withNewsParam(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === undefined || value === '') next.delete(name);
  else next.set(name, value);
  return next;
}

/**
 * News and macro (`/news`, 05_UI_Spec section 7): the news-risk state, then the calendar, the
 * headlines and the detected market moves. A headline is always context, never the reason for a
 * move.
 */
export default function NewsPage() {
  usePageTitle('News');
  const [params, setParams] = useSearchParams();
  const view = newsViewFromParams(params);
  const state = useNewsState();
  const settings = useSettings();
  const nowMs = useNow(15_000);

  const change = (name: string, value: string | undefined) => {
    setParams(withNewsParam(params, name, value), { replace: true });
  };

  return (
    <Stack gap="md" data-testid="page-news">
      <Stack gap={4}>
        <Title order={1} size="h2">
          News
        </Title>
        <Text c="dimmed" size="sm" maw={760}>
          Scheduled events, headlines and sudden moves of gold. This is context for you: it never
          creates a signal, and a headline is never shown as the reason for a move.
        </Text>
      </Stack>

      {state.data ? (
        <NewsStateCard
          state={state.data}
          nowMs={nowMs}
          gateMode={settings.data?.advisoryGates.newsWindow}
        />
      ) : (
        <Text size="sm" c="dimmed" role="status" data-testid="news-state-pending">
          {state.isError ? 'Could not load the news state.' : 'Loading…'}
        </Text>
      )}

      <Tabs
        value={view.tab}
        onChange={(value) => {
          change('tab', value === 'calendar' ? undefined : (value ?? undefined));
        }}
        keepMounted={false}
      >
        <Tabs.List className="tabs-scroll" aria-label="News sections">
          {TABS.map((tab) => (
            <Tabs.Tab key={tab} value={tab}>
              {TAB_LABELS[tab]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="calendar" pt="md">
          <CalendarTab
            state={state.data?.state}
            importance={view.importance}
            onImportance={(importance: MacroImportance | undefined) => {
              change('importance', importance);
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="headlines" pt="md">
          <HeadlinesTab
            filters={{ minImpact: view.minImpact, topic: view.topic }}
            onFilter={change}
          />
        </Tabs.Panel>
        <Tabs.Panel value="moves" pt="md">
          <MovesTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
