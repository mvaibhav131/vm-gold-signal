import { Badge, Button, Group, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
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
import { ThemeToggle } from './ThemeToggle';

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

/** A label above its value, the same shape for every item of the bar. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="status-stat">
      <span className="status-label">{label}</span>
      {children}
    </div>
  );
}

const PENDING: Chip = { text: '…', tone: 'neutral' };

/**
 * The global status bar: always visible, every state written as text (05_UI_Spec section 3).
 * Row 1 is the price. Row 2 holds the market state chips and the account controls; on a phone
 * the chips scroll sideways inside their own box so the page itself never scrolls sideways.
 */
export function StatusBar() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isPhone = useMediaQuery('(max-width: 47.99em)');
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
      <div className="status-row">
        <Stat label="XAUUSD">
          <Text component="div" lh={1.15} data-testid="status-price">
            {bid === undefined || ask === undefined ? (
              '—'
            ) : (
              <>
                <Text span fw={700} fz={24}>
                  {formatPrice(midOf(bid, ask))}
                </Text>{' '}
                <Text span size="sm" c="dimmed" className="status-detail">
                  (bid {formatPrice(bid)} / ask {formatPrice(ask)})
                </Text>
              </>
            )}
          </Text>
        </Stat>
        <Stat label="Spread">
          <Text fw={600} data-testid="status-spread">
            {spread === undefined ? '—' : formatSpread(spread)}
          </Text>
        </Stat>
        <Stat label="Feed">
          <ChipBadge
            testId="status-freshness"
            chip={
              feedState === undefined
                ? PENDING
                : freshnessChip(feedState, ageMs, data?.engine.warmup.progressPct ?? 0)
            }
          />
        </Stat>
      </div>

      <div className="status-row status-row-chips">
        <div
          className="status-chips"
          role="group"
          aria-label="Market details"
          tabIndex={isPhone ? 0 : undefined}
        >
          <Stat label="Session">
            <ChipBadge
              testId="status-session"
              chip={data ? { text: labelOf(data.session), tone: 'neutral' } : PENDING}
            />
          </Stat>
          <Stat label="Regime">
            <ChipBadge
              testId="status-regime"
              chip={data ? { text: labelOf(data.regime), tone: 'neutral' } : PENDING}
            />
          </Stat>
          <Stat label="Engine">
            <ChipBadge testId="status-engine" chip={data ? engineChip(data.engine) : PENDING} />
          </Stat>
          <Stat label="Mode">
            <ChipBadge testId="status-mode" chip={data ? modeChip(data.mode) : PENDING} />
          </Stat>
          <Stat label="Strategies">
            <ChipBadge
              testId="status-strategy"
              chip={strategies.data ? strategyChip(strategies.data.map((s) => s.status)) : PENDING}
            />
          </Stat>
        </div>
        <Group gap={8} wrap="nowrap" className="status-actions">
          <ThemeToggle />
          <Button
            variant="default"
            size="sm"
            loading={logout.isPending}
            onClick={() => {
              logout.mutate();
            }}
          >
            Log out
          </Button>
        </Group>
      </div>
    </div>
  );
}
