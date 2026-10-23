import { Group, Stack, Title } from '@mantine/core';

import { usePageTitle } from '../hooks';
import { ChartPanel } from './ChartPanel';
import { CountersRow } from './CountersRow';
import { EventsCard } from './EventsCard';
import { OpenSignalsPanel } from './OpenSignalsPanel';
import { PreviewPicker } from './PreviewPicker';
import { RecentSignals } from './RecentSignals';
import { WhyNoSignalCard } from './WhyNoSignalCard';

/**
 * The dashboard (05_UI_Spec section 4). The page order in the document is the phone order:
 * open signals (or the card that says why there are none), chart, counters, next event.
 * On a wide screen the stylesheet places the chart on the left and the signals on the right.
 */
export function DashboardPage() {
  usePageTitle('Dashboard');

  return (
    <Stack gap="md" data-testid="page-dashboard">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Title order={1} size="h2">
          Dashboard
        </Title>
        <PreviewPicker />
      </Group>
      <div className="dash-grid">
        <OpenSignalsPanel />
        <ChartPanel />
        <CountersRow />
        <div className="dash-bottom">
          <EventsCard />
          <RecentSignals />
          <WhyNoSignalCard />
        </div>
      </div>
    </Stack>
  );
}
