import { Alert, Group, Select, Stack, Table, Text, Title, VisuallyHidden } from '@mantine/core';
import type { CalendarEvent, NewsEventsResponse, NewsStateResponse } from '@vmgs/contracts';
import { MACRO_IMPORTANCE, type MacroImportance } from '@vmgs/core';

import { DASH, QueryBoundary, ScrollBox } from '../components/page';
import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import { useNewsEvents } from '../data/queries';
import {
  IMPORTANCE_LABELS,
  IMPORTANCE_TONE,
  formatEventValue,
  formatMove,
  formatSurprise,
} from '../format/news';
import { formatSpan } from '../format/time';
import { useNow } from '../hooks';
import { FEED_STALE_AFTER_MS } from './feeds';

const ALL = 'all';

export function ImportanceBadge({ importance }: { importance: MacroImportance }) {
  return (
    <ToneBadge tone={IMPORTANCE_TONE[importance]} size="sm">
      {IMPORTANCE_LABELS[importance]}
    </ToneBadge>
  );
}

function UpcomingTable({ events, nowMs }: { events: readonly CalendarEvent[]; nowMs: number }) {
  return (
    <ScrollBox label="Upcoming events, scrolls sideways">
      <Table
        verticalSpacing={6}
        horizontalSpacing="xs"
        fz="sm"
        miw={640}
        data-testid="news-upcoming"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>In</Table.Th>
            <Table.Th>Event</Table.Th>
            <Table.Th>Importance</Table.Th>
            <Table.Th ta="right">Forecast</Table.Th>
            <Table.Th ta="right">Previous</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={event.id} data-testid={`news-event-${event.id}`}>
              <Table.Td>
                <TimeText iso={event.scheduledAt} withDate />
              </Table.Td>
              <Table.Td>{formatSpan((Date.parse(event.scheduledAt) - nowMs) / 1000)}</Table.Td>
              <Table.Th scope="row" fw={600}>
                {event.name}
              </Table.Th>
              <Table.Td>
                <ImportanceBadge importance={event.importance} />
              </Table.Td>
              <Table.Td ta="right">{formatEventValue(event.forecast, event.unit)}</Table.Td>
              <Table.Td ta="right">{formatEventValue(event.previous, event.unit)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

/** A value that is not measured: a dash, and the reason for a screen reader. */
function NotMeasured({ reason }: { reason: string }) {
  return (
    <span>
      {DASH}
      <VisuallyHidden>{reason}</VisuallyHidden>
    </span>
  );
}

function PastTable({ events }: { events: readonly CalendarEvent[] }) {
  return (
    <ScrollBox label="Released events, scrolls sideways">
      <Table verticalSpacing={6} horizontalSpacing="xs" fz="sm" miw={980} data-testid="news-past">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Event</Table.Th>
            <Table.Th>Importance</Table.Th>
            <Table.Th ta="right">Actual</Table.Th>
            <Table.Th ta="right">Forecast</Table.Th>
            <Table.Th ta="right">Previous</Table.Th>
            <Table.Th ta="right">Revised previous</Table.Th>
            <Table.Th ta="right">Surprise</Table.Th>
            <Table.Th ta="right">Gold in the 5 min after</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={event.id} data-testid={`news-event-${event.id}`}>
              <Table.Td>
                <TimeText iso={event.scheduledAt} withDate />
              </Table.Td>
              <Table.Th scope="row" fw={600}>
                {event.name}
              </Table.Th>
              <Table.Td>
                <ImportanceBadge importance={event.importance} />
              </Table.Td>
              <Table.Td ta="right">
                {event.actual === null ? (
                  <Text span size="xs" c="dimmed">
                    Not delivered yet
                  </Text>
                ) : (
                  <b>{formatEventValue(event.actual, event.unit)}</b>
                )}
              </Table.Td>
              <Table.Td ta="right">{formatEventValue(event.forecast, event.unit)}</Table.Td>
              <Table.Td ta="right">{formatEventValue(event.previous, event.unit)}</Table.Td>
              <Table.Td ta="right">{formatEventValue(event.revisedPrevious, event.unit)}</Table.Td>
              <Table.Td ta="right">
                {event.surpriseSigma === null ? (
                  <NotMeasured reason="Surprise not measured" />
                ) : (
                  formatSurprise(event.surpriseSigma)
                )}
              </Table.Td>
              <Table.Td ta="right">
                {event.goldMoveAfter === null ? (
                  <NotMeasured reason="Move of gold not measured" />
                ) : (
                  formatMove(event.goldMoveAfter)
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollBox>
  );
}

/**
 * The calendar: what is still to come with a countdown, and what was released with the surprise
 * and the move of gold after it. With the calendar feed down the upcoming list is replaced by a
 * warning, because an empty list would read as "no event".
 */
export function CalendarView({
  data,
  state,
  nowMs,
  importance,
}: {
  data: NewsEventsResponse;
  state: NewsStateResponse['state'] | undefined;
  nowMs: number;
  importance: MacroImportance | undefined;
}) {
  const upcoming = data.items.filter((event) => Date.parse(event.scheduledAt) > nowMs);
  const past = data.items
    .filter((event) => Date.parse(event.scheduledAt) <= nowMs)
    .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt));
  const filtered =
    importance === undefined ? '' : ` of ${IMPORTANCE_LABELS[importance].toLowerCase()} importance`;
  const stale = data.sourceAgeS === null || data.sourceAgeS * 1000 > FEED_STALE_AFTER_MS;

  return (
    <Stack gap="lg">
      <Group gap="sm" data-testid="calendar-fetch-age">
        <Text size="sm">
          {data.sourceAgeS === null
            ? 'The calendar has never been fetched.'
            : `Calendar last fetched ${formatSpan(data.sourceAgeS)} ago.`}
        </Text>
        {stale && (
          <ToneBadge tone="warning" size="sm">
            Calendar feed not answering
          </ToneBadge>
        )}
      </Group>

      <Stack gap="xs">
        <Title order={3} size="h5">
          Upcoming
        </Title>
        {state === 'UNKNOWN' ? (
          <Alert
            variant="light"
            color="warning"
            role="note"
            title="Upcoming events are not known"
            data-testid="news-upcoming"
          >
            The calendar feed is unavailable, so an event that is still to come may be missing. An
            empty list here would not mean that nothing is scheduled.
          </Alert>
        ) : upcoming.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="news-upcoming">
            {state === undefined
              ? 'The list of upcoming events is confirmed once the news state has loaded.'
              : `No event${filtered} in the next week.`}
          </Text>
        ) : (
          <UpcomingTable events={upcoming} nowMs={nowMs} />
        )}
      </Stack>

      <Stack gap="xs">
        <Title order={3} size="h5">
          Released
        </Title>
        {past.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="news-past">
            No event{filtered} in the last two weeks.
          </Text>
        ) : (
          <PastTable events={past} />
        )}
        <Text size="xs" c="dimmed">
          The surprise is the actual value minus the forecast, in standard deviations of the past
          surprises of the same indicator. The move of gold is measured from the recorded 1-minute
          candles. A dash means it could not be measured.
        </Text>
      </Stack>
    </Stack>
  );
}

export function CalendarTab({
  state,
  importance,
  onImportance,
}: {
  state: NewsStateResponse['state'] | undefined;
  importance: MacroImportance | undefined;
  onImportance: (importance: MacroImportance | undefined) => void;
}) {
  const query = useNewsEvents(importance === undefined ? {} : { importance });
  const nowMs = useNow(15_000);
  return (
    <Stack gap="md">
      <Select
        label="Importance"
        data={[
          { value: ALL, label: 'All' },
          ...MACRO_IMPORTANCE.toReversed().map((value) => ({
            value,
            label: IMPORTANCE_LABELS[value],
          })),
        ]}
        value={importance ?? ALL}
        onChange={(value) => {
          onImportance(MACRO_IMPORTANCE.find((candidate) => candidate === value));
        }}
        allowDeselect={false}
        maw={220}
        data-testid="news-filter-importance"
      />
      <QueryBoundary query={query} what="the calendar">
        {(data) => <CalendarView data={data} state={state} nowMs={nowMs} importance={importance} />}
      </QueryBoundary>
    </Stack>
  );
}
