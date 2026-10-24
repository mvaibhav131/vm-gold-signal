import { Anchor, Stack, Text, Title } from '@mantine/core';
import { Suspense, lazy, type ReactNode } from 'react';
import { Link } from 'react-router';

import { usePageTitle } from '../hooks';

export { DashboardPage } from '../dashboard/DashboardPage';

const HistoryPage = lazy(() => import('../history/HistoryPage'));
const SignalDetailScreen = lazy(() => import('../detail/SignalDetailPage'));
const AnalyticsScreen = lazy(() => import('../analytics/AnalyticsPage'));
const NewsScreen = lazy(() => import('../news/NewsPage'));
const SystemScreen = lazy(() => import('../system/SystemPage'));

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
    <Lazy title="Analytics" testId="page-analytics">
      <AnalyticsScreen />
    </Lazy>
  );
}

export function NewsPage() {
  return (
    <Lazy title="News" testId="page-news">
      <NewsScreen />
    </Lazy>
  );
}

export function SystemPage() {
  return (
    <Lazy title="System" testId="page-system">
      <SystemScreen />
    </Lazy>
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
