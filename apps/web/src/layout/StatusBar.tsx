import { Badge, Button, Group, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApi } from '../api/context';
import { ME_KEY } from '../auth/RequireAuth';
import { useDayChange, useDisplayTz, useQuote, useSnapshot, useStrategies } from '../data/queries';
import { signedFixed } from '../format/dayChange';
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
import { PriceTicker } from './PriceTicker';
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

function clockText(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}

/** How far the price has moved since the trading day opened: an arrow, the amount and the percentage, in green or red. */
function DayChangeStat({ price }: { price: number | null }) {
  const timeZone = useDisplayTz();
  const change = useDayChange(price);
  const direction =
    change === null || change.change === 0 ? 'flat' : change.change > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
  const label = change?.partial === true ? `Since ${clockText(change.sinceMs, timeZone)}` : 'Day';
  const text =
    change === null ? '—' : `${signedFixed(change.change, 3)} (${signedFixed(change.pct, 2)}%)`;
  return (
    <Stat label={label}>
      <Text
        fw={600}
        className={`status-change status-change-${direction}`}
        data-testid="status-change"
        data-direction={direction}
        title={
          change === null
            ? undefined
            : `Since the trading day opened (17:00 New York): from ${formatPrice(change.reference)}`
        }
      >
        {arrow !== '' && (
          <span className="status-arrow" aria-hidden="true">
            {arrow}
          </span>
        )}
        {text}
      </Text>
    </Stat>
  );
}

/**
 * The global status bar: always visible, every state written as text (05_UI_Spec section 3).
 * On a wide screen it is one line: the price with its change, the spread and the feed, then the market state chips and the
 * account controls (it wraps to a second line when the window is too narrow for one). On a phone the price comes first and
 * the chips scroll sideways inside their own box so the page itself never scrolls sideways.
 */
export function StatusBar() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isPhone = useMediaQuery('(max-width: 47.99em)');
  const quote = useQuote();
  const snapshot = useSnapshot();
  const strategies = useStrategies();
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
  const mid = bid === undefined || ask === undefined ? null : midOf(bid, ask);

  return (
    <div className="status-bar" role="region" aria-label="Market status">
      <div className="status-row">
        <Stat label="XAUUSD">
          <PriceTicker bid={bid} ask={ask} />
        </Stat>
        <DayChangeStat price={mid} />
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
            <ChipBadge
              testId="status-engine"
              chip={data ? engineChip(data.engine, feedState) : PENDING}
            />
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
