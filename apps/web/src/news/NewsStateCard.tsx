import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { NewsStateResponse } from '@vmgs/contracts';
import type { GateMode } from '@vmgs/core';

import { TimeText } from '../components/TimeText';
import { ToneBadge } from '../components/ToneBadge';
import type { Tone } from '../format/format';
import { formatSpan } from '../format/time';
import { activeNewsWindow, newsWindowOf } from './window';

export const NEWS_STATE_CHIP: Readonly<
  Record<NewsStateResponse['state'], { text: string; tone: Tone }>
> = {
  CLEAR: { text: 'CLEAR', tone: 'neutral' },
  IN_WINDOW: { text: 'IN WINDOW', tone: 'warning' },
  UNKNOWN: { text: 'UNKNOWN', tone: 'warning' },
};

function GateSentence({ mode }: { mode: GateMode | undefined }) {
  if (mode === 'warn') return <> Signals are still sent, with a NEWS WINDOW warning.</>;
  if (mode === 'block') {
    return <> You set this flag to block: no signal is sent while the window lasts.</>;
  }
  return null;
}

/**
 * The news-risk state (05_UI_Spec section 7). Three states that must look different: nothing close
 * (`CLEAR`), an event close (`IN_WINDOW`, with the window) and "the calendar feed is unavailable"
 * (`UNKNOWN`), which is never worded as "no event".
 */
export function NewsStateCard({
  state,
  nowMs,
  gateMode,
}: {
  state: NewsStateResponse;
  nowMs: number;
  gateMode: GateMode | undefined;
}) {
  const chip = NEWS_STATE_CHIP[state.state];
  const window = activeNewsWindow(state, nowMs);
  const next = state.next;
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-label="News-risk state"
      data-testid="news-state"
    >
      <Stack gap="xs">
        <Group gap="sm">
          <Title order={2} size="h4">
            News-risk state
          </Title>
          <ToneBadge tone={chip.tone} data-testid="news-state-chip">
            {chip.text}
          </ToneBadge>
        </Group>

        <Text size="sm" data-testid="news-state-text">
          {state.state === 'UNKNOWN' && (
            <>
              The calendar feed is unavailable, so the system cannot tell whether an event is close.
              This is not the same as no event. Signals carry a NEWS UNKNOWN warning.
              {state.sourceAgeS === null
                ? ' The calendar has never been fetched.'
                : ` The last successful calendar fetch was ${formatSpan(state.sourceAgeS)} ago.`}
            </>
          )}
          {state.state === 'IN_WINDOW' && (
            <>
              A high-impact event is close
              {window ? (
                <>
                  : <b>{window.event.name}</b> at <TimeText iso={window.event.scheduledAt} />. The
                  news window runs from <TimeText iso={new Date(window.fromMs).toISOString()} /> to{' '}
                  <TimeText iso={new Date(window.toMs).toISOString()} />.
                </>
              ) : (
                '.'
              )}
              <GateSentence mode={gateMode} />
            </>
          )}
          {state.state === 'CLEAR' &&
            (next ? (
              <>
                No high-impact event is inside its news window. Next: <b>{next.name}</b> at{' '}
                <TimeText iso={next.scheduledAt} withDate /> (in{' '}
                {formatSpan((Date.parse(next.scheduledAt) - nowMs) / 1000)}). Its news window starts
                at <TimeText iso={new Date(newsWindowOf(next).fromMs).toISOString()} />.
              </>
            ) : (
              <>No high-impact event is scheduled.</>
            ))}
        </Text>

        <Text size="xs" c="dimmed">
          The news state only warns. It blocks a signal only if you set the news-window flag to
          block (System, Alerts).
        </Text>
      </Stack>
    </Paper>
  );
}
