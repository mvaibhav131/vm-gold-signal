import { Badge, Button, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useApi } from '../api/context';
import { KEYS, useOpenSignals, useQuote, useSnapshot } from '../data/queries';
import { formatFixed } from '../format/format';
import { isDrawn } from './chart/signalVisibility';
import { chooseAll, isUnfolded, type FoldChoices } from './foldChoices';
import { PauseDialog } from './PauseDialog';
import { SignalCard } from './SignalCard';
import { MarketClosedCard, PausedCard, WaitCard, WarmingUpCard } from './StateCards';
import { useSignalVisibility } from './useSignalVisibility';

/**
 * The right column of the dashboard (05_UI_Spec section 4): the number of open signals and their
 * total risk, then one card per open signal, newest first, or the card that says why there is none.
 */
export function OpenSignalsPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const snapshot = useSnapshot();
  const open = useOpenSignals();
  const quote = useQuote();
  const [pausing, setPausing] = useState(false);
  const [choices, setChoices] = useState<FoldChoices>({});
  const { visibility, toggleSignal } = useSignalVisibility();

  const reload = () => queryClient.invalidateQueries({ queryKey: KEYS.snapshot });
  const pause = useMutation({
    mutationFn: (minutes: number | undefined) =>
      api.pauseEngine(minutes === undefined ? {} : { minutes }),
    onSuccess: async () => {
      await reload();
      setPausing(false);
    },
  });
  const resume = useMutation({ mutationFn: () => api.resumeEngine(), onSuccess: reload });

  const data = snapshot.data;
  const items = open.data?.items ?? [];
  const ids = items.map((item) => item.signal.id);
  const feedState = quote?.feedState ?? data?.feedState;
  const paused = data?.engine.status === 'PAUSED';
  const marketClosed = feedState === 'MARKET_CLOSED';
  const warmingUp = data ? !data.engine.warmup.ready : false;
  const allUnfolded = items.every((item, index) =>
    isUnfolded(choices, item.signal.id, index, items.length),
  );

  return (
    <section
      aria-labelledby="open-signals-title"
      data-testid="open-signals"
      className="dash-signals"
    >
      <div className="dash-signals-inner">
        <Stack gap="md">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="xs">
              <Title order={2} size="h4" id="open-signals-title">
                Open signals
              </Title>
              <Badge variant="light" color="gold" data-testid="open-count">
                {open.data?.openCount ?? 0}
              </Badge>
            </Group>
            <Group gap="xs">
              {items.length > 1 && (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setChoices(chooseAll(ids, !allUnfolded));
                  }}
                  data-testid="fold-all"
                >
                  {allUnfolded ? 'Fold all' : 'Unfold all'}
                </Button>
              )}
              {data && !paused && (
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => {
                    setPausing(true);
                  }}
                  data-testid="pause-button"
                >
                  Pause engine
                </Button>
              )}
            </Group>
          </Group>

          {(open.data?.openCount ?? 0) > 0 && (
            <Text size="sm">
              Total open risk{' '}
              <b data-testid="open-risk">{formatFixed(open.data?.openRiskR ?? 0, 2)}R</b>
            </Text>
          )}
        </Stack>

        {/* The list scrolls inside the height of the chart, so many signals never push the page down. */}
        <div
          className="dash-signals-scroll"
          role="region"
          aria-label="Open signals list"
          tabIndex={0}
          data-testid="open-signals-scroll"
        >
          <Stack gap="md">
            {(snapshot.isPending || open.isPending) && (
              <Stack gap="sm" aria-busy="true" aria-label="Loading open signals">
                <Skeleton height={120} radius="md" />
                <Skeleton height={200} radius="md" />
              </Stack>
            )}
            {(snapshot.isError || open.isError) && (
              <Text role="alert" className="text-negative">
                Could not load the signals. Retrying.
              </Text>
            )}

            {data && paused && (
              <PausedCard
                engine={data.engine}
                onResume={() => {
                  resume.mutate();
                }}
                resuming={resume.isPending}
              />
            )}
            {data && marketClosed && <MarketClosedCard snapshot={data} />}
            {data && warmingUp && !marketClosed && <WarmingUpCard engine={data.engine} />}
            {data &&
              items.length === 0 &&
              !paused &&
              !marketClosed &&
              !warmingUp &&
              open.isSuccess && <WaitCard engine={data.engine} />}

            {items.map((item, index) => {
              const id = item.signal.id;
              const unfolded = isUnfolded(choices, id, index, items.length);
              return (
                <SignalCard
                  key={id}
                  item={item}
                  feedState={feedState}
                  expanded={unfolded}
                  onToggleExpanded={() => {
                    setChoices((current) => ({ ...current, [id]: !unfolded }));
                  }}
                  drawnOnChart={isDrawn(visibility, item.signal.seq)}
                  onToggleDrawn={() => {
                    toggleSignal(item.signal.seq);
                  }}
                />
              );
            })}
          </Stack>
        </div>
      </div>

      <PauseDialog
        opened={pausing}
        onClose={() => {
          setPausing(false);
        }}
        onConfirm={(minutes) => {
          pause.mutate(minutes);
        }}
        loading={pause.isPending}
      />
    </section>
  );
}
