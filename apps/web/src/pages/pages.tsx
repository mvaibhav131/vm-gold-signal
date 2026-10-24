import { Anchor, Stack, Text, Title } from '@mantine/core';
import { Suspense, lazy, type ReactNode } from 'react';
import { Link } from 'react-router';

import { usePageTitle } from '../hooks';
import { PlaceholderPage } from './PlaceholderPage';

export { DashboardPage } from '../dashboard/DashboardPage';

const HistoryPage = lazy(() => import('../history/HistoryPage'));
const SignalDetailScreen = lazy(() => import('../detail/SignalDetailPage'));

/** What a lazily loaded screen shows for a moment: its heading, so the page is never without one. */
function Loading({ title, testId }: { title: string; testId: string }) {
  return (
    <Stack gap="md" data-testid={testId}>
      <Title order={1} size="h2">
        {title}
      </Title>
      <Text c="dimmed">Loading…</Text>
    </Stack>
  );
}

function Lazy({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return <Suspense fallback={<Loading title={title} testId={testId} />}>{children}</Suspense>;
}

/** The history table is loaded when the screen is opened, so it does not weigh on the dashboard (05_UI_Spec section 1). */
export function SignalsPage() {
  return (
    <Lazy title="Signals" testId="page-signals">
      <HistoryPage />
    </Lazy>
  );
}

export function SignalDetailPage() {
  return (
    <Lazy title="Signal detail" testId="page-signal-detail">
      <SignalDetailScreen />
    </Lazy>
  );
}

export function AnalyticsPage() {
  return (
    <PlaceholderPage
      testId="page-analytics"
      title="Analytics"
      phase="U3"
      summary="How the signals really performed, measured from recorded results only."
      planned={[
        'KPI cards and a monthly table of generated and properly tracked signals',
        'Equity curve in R, breakdowns by strategy, side, session, regime and grade',
        'Failure analysis, evidence-group effectiveness, score calibration and drift',
        'No percentage is shown below 30 resolved trades, only the counts',
      ]}
    />
  );
}

export function NewsPage() {
  return (
    <PlaceholderPage
      testId="page-news"
      title="News"
      phase="U4"
      summary="Calendar events, headlines and sudden gold moves, with the news-risk state."
      planned={[
        'Calendar with forecast, previous and actual, and gold’s move after each release',
        'Clustered headlines with impact, topic and detection delay',
        'Market moves with the headlines that were visible, worded as possible causes only',
      ]}
    />
  );
}

export function SystemPage() {
  return (
    <PlaceholderPage
      testId="page-system"
      title="System"
      phase="U4"
      summary="Health of the feed and the worker, storage, strategies and your settings."
      planned={[
        'Health, storage and retention rules, strategy switches and their config',
        'Alert settings: Telegram, Web Push, language, advisory flags warn or block',
        'Display time zone, password, optional 2-step login and active sessions',
      ]}
    />
  );
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <Stack gap="md" data-testid="page-not-found">
      <Title order={1} size="h2">
        Page not found
      </Title>
      <Anchor component={Link} to="/">
        Go to the dashboard
      </Anchor>
    </Stack>
  );
}
