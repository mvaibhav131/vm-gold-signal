import { Anchor, Stack, Text, Title } from '@mantine/core';
import { Link, useParams } from 'react-router';

import { usePageTitle } from '../hooks';
import { PlaceholderPage } from './PlaceholderPage';

export { DashboardPage } from '../dashboard/DashboardPage';

export function SignalsPage() {
  return (
    <PlaceholderPage
      testId="page-signals"
      title="Signals"
      phase="U2"
      summary="The history of every signal with its result and the reason it failed, if it did."
      planned={[
        'Filters: date range, result, strategy, side, session, regime, cause, grade',
        'Table with levels, result, net R, duration, primary cause and the evidence shown at creation',
        'A summary strip: signals, valid results, win rate with interval, net R, profit factor',
      ]}
    />
  );
}

export function SignalDetailPage() {
  const { id } = useParams();
  usePageTitle('Signal detail');
  return (
    <Stack gap="md" data-testid="page-signal-detail">
      <Title order={1} size="h2">
        Signal detail
      </Title>
      <Text c="dimmed">
        Built in U2. This page will show signal <b>{id}</b>: levels, result, timeline, why it was
        produced, the automatic review and the stored evidence.
      </Text>
      <Anchor component={Link} to="/signals">
        Back to signals
      </Anchor>
    </Stack>
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
