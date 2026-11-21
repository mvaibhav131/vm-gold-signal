import { Button, Group, NumberInput, Stack, Text } from '@mantine/core';
import { LOT_STEP, OUNCES_PER_LOT, sizePosition } from '@vmgs/core';
import type { Signal } from '@vmgs/contracts';
import { useState } from 'react';

import { useRiskPrefs } from './useRiskPrefs';
import { MAX_BALANCE_USD, MAX_RISK_PCT, MIN_BALANCE_USD, MIN_RISK_PCT } from './riskPrefs';

const usd = (value: number): string =>
  `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

/** A number that is typed freely and taken when the field is left; a number outside the limits goes back to what it was. */
function Field({
  label,
  value,
  min,
  max,
  step,
  decimalScale,
  onCommit,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimalScale: number;
  onCommit: (value: number) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState<string | number>(value);
  return (
    <NumberInput
      label={label}
      size="xs"
      value={draft}
      min={min}
      max={max}
      step={step}
      decimalScale={decimalScale}
      hideControls
      data-testid={testId}
      onChange={setDraft}
      onBlur={() => {
        if (typeof draft === 'number' && draft >= min && draft <= max) onCommit(draft);
        else setDraft(value);
      }}
    />
  );
}

/**
 * How many lots a signal is for a demo account: the risk of a trade is fixed in dollars (balance x risk percent), so the stop costs the
 * same share of the balance whatever its distance (`sizePosition` of core). It is advice for an order the owner places by hand.
 */
export function PositionSize({
  signal,
}: {
  signal: Pick<Signal, 'entry' | 'tp1' | 'tp2' | 'riskDistance'>;
}) {
  const { prefs, change } = useRiskPrefs();
  const [editing, setEditing] = useState(false);
  if (!(signal.riskDistance > 0)) return null;
  const size = sizePosition(signal, { balanceUsd: prefs.balanceUsd, riskPct: prefs.riskPct });
  // what the smallest position the broker takes (0.01 lot) would lose at the stop
  const oneStep = LOT_STEP * OUNCES_PER_LOT * signal.riskDistance;

  return (
    <Stack gap={4} data-testid="position-size">
      <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed" data-testid="position-size-account">
          Position size for {usd(prefs.balanceUsd)}, risking {prefs.riskPct}% ({usd(size.budgetUsd)}
          )
        </Text>
        <Button
          variant="subtle"
          size="compact-xs"
          aria-expanded={editing}
          onClick={() => {
            setEditing((open) => !open);
          }}
          data-testid="position-size-edit"
        >
          {editing ? 'Done' : 'Change'}
        </Button>
      </Group>
      {size.tooSmall ? (
        <Text size="sm" className="text-negative" role="status" data-testid="position-size-lots">
          Too wide for this account: even 0.01 lot would lose {usd(oneStep)} at the stop, more than{' '}
          {usd(size.budgetUsd)}. Skip it, or raise the balance or the risk.
        </Text>
      ) : (
        <Text size="sm" fw={600} data-testid="position-size-lots">
          {size.lots.toFixed(2)} lot · stop −{usd(size.riskUsd)} · TP1 +{usd(size.tp1Usd)}
          {size.tp2Usd === null ? '' : ` · TP2 +${usd(size.tp2Usd)}`}
        </Text>
      )}
      {editing && (
        <Group gap="sm" align="flex-end" data-testid="position-size-form">
          <Field
            label="Demo balance (USD)"
            value={prefs.balanceUsd}
            min={MIN_BALANCE_USD}
            max={MAX_BALANCE_USD}
            step={1000}
            decimalScale={0}
            onCommit={(balanceUsd) => {
              change({ balanceUsd });
            }}
            testId="position-size-balance"
          />
          <Field
            label="Risk per trade (%)"
            value={prefs.riskPct}
            min={MIN_RISK_PCT}
            max={MAX_RISK_PCT}
            step={0.1}
            decimalScale={2}
            onCommit={(riskPct) => {
              change({ riskPct });
            }}
            testId="position-size-risk"
          />
        </Group>
      )}
    </Stack>
  );
}
