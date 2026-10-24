import { Alert, Anchor, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { Link, useParams } from 'react-router';

import { ApiError } from '../api/client';
import { EvidenceBlock } from '../dashboard/EvidenceBlock';
import { WhyPanel } from '../dashboard/WhyPanel';
import { useSignalDetail } from '../data/queries';
import { signalLabel } from '../format/signal';
import { usePageTitle } from '../hooks';
import { LevelsBlock } from './LevelsBlock';
import { ResultBlock } from './ResultBlock';
import { ReviewBlock } from './ReviewBlock';
import { SignalHeader } from './SignalHeader';
import { SnapshotBlock } from './SnapshotBlock';
import { TimelineBlock } from './TimelineBlock';
import { TradeChart } from './TradeChart';

function BackLink() {
  return (
    <Anchor component={Link} to="/signals" size="sm">
      Back to signals
    </Anchor>
  );
}

/**
 * One signal (`/signals/:id`, 05_UI_Spec section 5): header, levels, result, timeline, the chart
 * around the trade, why it was produced, the evidence it carried, the automatic review and the
 * raw snapshot. An open signal refreshes by itself, and so does a preliminary review.
 */
export default function SignalDetailPage() {
  const { id = '' } = useParams();
  const query = useSignalDetail(id);
  const detail = query.data;
  usePageTitle(detail ? `Signal ${signalLabel(detail.signal.seq)}` : 'Signal detail');

  if (query.isPending) {
    return (
      <Stack gap="md" data-testid="page-signal-detail">
        <Title order={1} size="h2">
          Signal detail
        </Title>
        <Text c="dimmed">Loading…</Text>
      </Stack>
    );
  }

  if (!detail) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Stack gap="md" data-testid="page-signal-detail">
        <Title order={1} size="h2">
          Signal detail
        </Title>
        {missing ? (
          <Alert
            color="warning"
            title="Signal not found"
            role="alert"
            data-testid="detail-not-found"
          >
            There is no signal with this id. It may have been mistyped.
          </Alert>
        ) : (
          <Alert color="negative" title="Could not load the signal" role="alert">
            <Group gap="sm">
              <Text size="sm">Check the connection and try again.</Text>
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Retry
              </Button>
            </Group>
          </Alert>
        )}
        <BackLink />
      </Stack>
    );
  }

  const { signal, state, events, outcome, autopsy, snapshotAvailable } = detail;
  return (
    <Stack gap="md" data-testid="page-signal-detail">
      <Group justify="space-between" align="baseline">
        <Title order={1} size="h2">
          Signal detail
        </Title>
        <BackLink />
      </Group>

      <SignalHeader signal={signal} />

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Stack gap="md">
          <LevelsBlock signal={signal} />
          <ResultBlock outcome={outcome} state={state} />
        </Stack>
        <TimelineBlock events={events} />
      </SimpleGrid>

      <TradeChart signal={signal} outcome={outcome} />

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Paper
          withBorder
          p="md"
          radius="md"
          component="section"
          aria-labelledby="detail-why-title"
          data-testid="detail-why"
        >
          <Stack gap="sm">
            <Title order={2} size="h4" id="detail-why-title">
              Why this signal
            </Title>
            <Text size="xs" c="dimmed">
              Exactly as it was created and sent.
            </Text>
            <Text size="sm" fw={600}>
              {signal.explanation.headline}
            </Text>
            <WhyPanel explanation={signal.explanation} signalSeq={signal.seq} showTitle={false} />
          </Stack>
        </Paper>
        <Stack gap="md">
          <Paper
            withBorder
            p="md"
            radius="md"
            component="section"
            aria-labelledby="detail-evidence-title"
            data-testid="detail-evidence"
          >
            <Stack gap="sm">
              <Title order={2} size="h4" id="detail-evidence-title">
                Evidence at creation
              </Title>
              <EvidenceBlock evidence={signal.evidence} />
            </Stack>
          </Paper>
          <ReviewBlock autopsy={autopsy} outcome={outcome} />
        </Stack>
      </SimpleGrid>

      <SnapshotBlock id={signal.id} available={snapshotAvailable} />
    </Stack>
  );
}
