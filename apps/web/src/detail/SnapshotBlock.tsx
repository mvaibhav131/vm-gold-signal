import { Accordion, Code, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';

import { ApiError } from '../api/client';
import { useSignalSnapshot } from '../data/queries';

const PRUNED_TEXT = 'Snapshot removed by retention; summary above is kept.';

function SnapshotJson({ id }: { id: string }) {
  const snapshot = useSignalSnapshot(id, true);
  if (snapshot.isPending) {
    return (
      <Text size="sm" c="dimmed">
        Loading…
      </Text>
    );
  }
  if (snapshot.error instanceof ApiError && snapshot.error.code === 'snapshot_pruned') {
    return (
      <Text size="sm" data-testid="detail-snapshot-pruned">
        {PRUNED_TEXT}
      </Text>
    );
  }
  if (snapshot.isError) {
    return (
      <Text size="sm" role="alert" className="text-negative">
        Could not load the snapshot.
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize
      mah={360}
      type="auto"
      viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Feature snapshot JSON' }}
    >
      <Code block data-testid="detail-snapshot-json">
        {JSON.stringify(snapshot.data.features, null, 2)}
      </Code>
    </ScrollArea.Autosize>
  );
}

/**
 * The raw feature snapshot, collapsed JSON (05_UI_Spec section 5.9). It is only fetched when it is
 * opened. After the retention window it is gone and the page says so; the summary above stays.
 */
export function SnapshotBlock({ id, available }: { id: string; available: boolean }) {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-labelledby="detail-snapshot-title"
      data-testid="detail-snapshot"
    >
      <Stack gap="sm">
        <Title order={2} size="h4" id="detail-snapshot-title">
          Raw feature snapshot
        </Title>
        {available ? (
          <Accordion variant="contained" radius="md" value={opened} onChange={setOpened}>
            <Accordion.Item value="snapshot">
              <Accordion.Control>
                Every feature at the moment of the signal (JSON)
              </Accordion.Control>
              <Accordion.Panel>{opened === 'snapshot' && <SnapshotJson id={id} />}</Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        ) : (
          <Text size="sm" data-testid="detail-snapshot-pruned">
            {PRUNED_TEXT}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
