import { Badge, Button, Group, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApi } from '../api/context';
import { ME_KEY } from '../auth/RequireAuth';
import {
  engineChip,
  formatPrice,
  formatSpread,
  freshnessChip,
  labelOf,
  midOf,
  modeChip,
  strategyChip,
  type Chip,
  type Tone,
} from '../format/format';
import { useQuote } from '../hooks';

const TONE_COLOR: Record<Tone, string> = {
  positive: 'positive',
  negative: 'negative',
  warning: 'warning',
  info: 'info',
  brand: 'gold',
  neutral: 'gray',
};

function ChipBadge({ chip, testId }: { chip: Chip; testId: string }) {
  return (
    <Badge variant="light" color={TONE_COLOR[chip.tone]} data-testid={testId}>
      {chip.text}
    </Badge>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {children}
    </Group>
  );
}

const PENDING: Chip = { text: '…', tone: 'neutral' };

/** The global status bar: always visible, every state written as text (05_UI_Spec section 3). */
export function StatusBar() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const quote = useQuote();
  const snapshot = useQuery({
    queryKey: ['snapshot'],
    queryFn: () => api.getSnapshot(),
    refetchInterval: 5000,
  });
  const strategies = useQuery({ queryKey: ['strategies'], queryFn: () => api.getStrategies() });
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, null);
      void navigate('/login', { replace: true });
    },
  });

  const data = snapshot.data;
  const bid = quote?.bid ?? data?.bid;
  const ask = quote?.ask ?? data?.ask;
  const spread = quote?.spread ?? data?.spread;
  const feedState = quote?.feedState ?? data?.feedState;
  const ageMs = quote?.ageMs ?? data?.ageMs ?? 0;

  return (
    <div className="status-bar" role="region" aria-label="Market status">
      <Group gap="md" justify="space-between" align="center">
        <Group gap="md" align="center" style={{ rowGap: 6 }}>
          <Item label="XAUUSD">
            <Text fw={700} size="lg" data-testid="status-price">
              {bid === undefined || ask === undefined
                ? '—'
                : `${formatPrice(midOf(bid, ask))} (bid ${formatPrice(bid)} / ask ${formatPrice(ask)})`}
            </Text>
          </Item>
          <Item label="Spread">
            <Text fw={600} data-testid="status-spread">
              {spread === undefined ? '—' : formatSpread(spread)}
            </Text>
          </Item>
          <Item label="Feed">
            <ChipBadge
              testId="status-freshness"
              chip={
                feedState === undefined
                  ? PENDING
                  : freshnessChip(feedState, ageMs, data?.engine.warmup.progressPct ?? 0)
              }
            />
          </Item>
          <Item label="Session">
            <ChipBadge
              testId="status-session"
              chip={data ? { text: labelOf(data.session), tone: 'neutral' } : PENDING}
            />
          </Item>
          <Item label="Regime">
            <ChipBadge
              testId="status-regime"
              chip={data ? { text: labelOf(data.regime), tone: 'neutral' } : PENDING}
            />
          </Item>
          <Item label="Engine">
            <ChipBadge testId="status-engine" chip={data ? engineChip(data.engine) : PENDING} />
          </Item>
          <Item label="Mode">
            <ChipBadge testId="status-mode" chip={data ? modeChip(data.mode) : PENDING} />
          </Item>
          <Item label="Strategies">
            <ChipBadge
              testId="status-strategy"
              chip={strategies.data ? strategyChip(strategies.data.map((s) => s.status)) : PENDING}
            />
          </Item>
        </Group>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          loading={logout.isPending}
          onClick={() => {
            logout.mutate();
          }}
        >
          Log out
        </Button>
      </Group>
    </div>
  );
}
