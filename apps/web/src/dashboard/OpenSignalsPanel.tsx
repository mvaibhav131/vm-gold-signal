import { Badge, Button, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useApi } from '../api/context';
import { KEYS, useOpenSignals, useQuote, useSnapshot } from '../data/queries';
import { formatFixed } from '../format/format';
import { PauseDialog } from './PauseDialog';
import { SignalCard } from './SignalCard';
import { MarketClosedCard, PausedCard, WaitCard, WarmingUpCard } from './StateCards';

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
  const feedState = quote?.feedState ?? data?.feedState;
  const paused = data?.engine.status === 'PAUSED';
  const marketClosed = feedState === 'MARKET_CLOSED';
  const warmingUp = data ? !data.engine.warmup.ready : false;

  return (
    <section
      aria-labelledby="open-signals-title"
      data-testid="open-signals"
      className="dash-signals"
    >
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

        {(open.data?.openCount ?? 0) > 0 && (
          <Text size="sm">
            Total open risk{' '}
            <b data-testid="open-risk">{formatFixed(open.data?.openRiskR ?? 0, 2)}R</b>
          </Text>
        )}

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
        {data && items.length === 0 && !paused && !marketClosed && !warmingUp && open.isSuccess && (
          <WaitCard engine={data.engine} />
        )}

        {items.map((item) => (
          <SignalCard key={item.signal.id} item={item} feedState={feedState} />
        ))}
      </Stack>

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
