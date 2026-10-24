import { Paper, Stack, Text, Title } from '@mantine/core';
import type { SignalEvent } from '@vmgs/contracts';

import { TimeText } from '../components/TimeText';
import { formatPrice } from '../format/format';
import { CAUSE_LABELS, EVENT_LABELS, exitReasonText } from '../format/signal';
import type { CauseCode } from '@vmgs/core';

/** The extra words of an event: the reason of an exit, the cause named by a review, what a TP1 did. */
function detailOf(event: SignalEvent): string | null {
  const meta = event.meta;
  switch (event.eventType) {
    case 'TP1_HIT':
      return typeof meta.closed === 'string' ? `${meta.closed} of the position closed` : null;
    case 'STOP_MOVED_TO_ENTRY':
      return 'break-even';
    case 'ALERT_QUEUED':
      return 'new signal alert';
    case 'AUTOPSY_PRELIMINARY':
    case 'AUTOPSY_FINAL':
      return typeof meta.primaryCause === 'string' && meta.primaryCause in CAUSE_LABELS
        ? CAUSE_LABELS[meta.primaryCause as CauseCode]
        : null;
    case 'TP2_HIT':
    case 'SL_HIT':
    case 'TIME_EXIT':
    case 'CANCELLED':
    case 'DATA_INVALID':
      return typeof meta.exitReason === 'string' ? exitReasonText(meta.exitReason) : null;
    case 'CREATED':
      return null;
  }
}

/** The signal events in the order they happened (05_UI_Spec section 5.4). */
export function TimelineBlock({ events }: { events: readonly SignalEvent[] }) {
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-labelledby="detail-timeline-title"
    >
      <Stack gap="sm">
        <Title order={2} size="h4" id="detail-timeline-title">
          Timeline
        </Title>
        <ol className="timeline" data-testid="detail-timeline">
          {events.map((event) => {
            const detail = detailOf(event);
            return (
              <li
                key={event.id}
                className="timeline-item"
                data-testid={`timeline-${event.eventType}`}
              >
                <Text size="xs" c="dimmed" component="div">
                  <TimeText iso={event.eventAt} withDate />
                </Text>
                <Text size="sm" fw={600} component="div">
                  {EVENT_LABELS[event.eventType]}
                  {event.price !== null && (
                    <Text span fw={400}>
                      {' '}
                      at {formatPrice(event.price)}
                    </Text>
                  )}
                </Text>
                {detail && (
                  <Text size="xs" c="dimmed" component="div">
                    {detail}
                  </Text>
                )}
              </li>
            );
          })}
        </ol>
      </Stack>
    </Paper>
  );
}
