import { Alert, Paper, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { STATS_SCOPES, type StatsScope } from '@vmgs/core';
import { useSearchParams } from 'react-router';

import { usePageTitle } from '../hooks';
import { BreakdownTabs } from './BreakdownTabs';
import { CalibrationSection } from './CalibrationChart';
import { DriftPanel } from './DriftPanel';
import { EquitySection } from './EquityCurve';
import { FailureAnalysis } from './FailureAnalysis';
import { GroupEffectiveness } from './GroupEffectiveness';
import { KpiCards } from './KpiCards';
import { MonthlySection } from './MonthlyTable';
import { NewsImpact } from './NewsImpact';
import { SCOPE_LABELS, SCOPE_NOTES, scopeFromParams, withScope } from './scope';

function ScopeSwitch({
  scope,
  onChange,
}: {
  scope: StatsScope;
  onChange: (scope: StatsScope) => void;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="xs">
        <SegmentedControl
          fullWidth
          aria-label="Which results to show"
          data-testid="scope-switch"
          value={scope}
          data={STATS_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
          onChange={(value) => {
            const next = STATS_SCOPES.find((candidate) => candidate === value);
            if (next) onChange(next);
          }}
        />
        <Text size="sm" c="dimmed" data-testid="scope-note">
          {SCOPE_NOTES[scope]}
        </Text>
      </Stack>
    </Paper>
  );
}

/**
 * Analytics (`/analytics`, 05_UI_Spec section 6.2). The scope is in the address bar, so a link
 * always opens the same view. Every number comes from the API; this page only lays it out and
 * keeps the rule that a percentage needs at least 30 results.
 */
export default function AnalyticsPage() {
  usePageTitle('Analytics');
  const [params, setParams] = useSearchParams();
  const scope = scopeFromParams(params);

  return (
    <Stack gap="md" data-testid="page-analytics">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Analytics
        </Title>
        <Text c="dimmed" size="sm" maw={760}>
          How the signals really performed, measured from recorded results only. A good number here
          does not promise the next signal.
        </Text>
      </Stack>

      <ScopeSwitch
        scope={scope}
        onChange={(next) => {
          setParams(withScope(params, next), { replace: true });
        }}
      />

      <KpiCards scope={scope} />
      <MonthlySection scope={scope} />
      <EquitySection scope={scope} />
      <BreakdownTabs scope={scope} />
      <FailureAnalysis scope={scope} />
      <GroupEffectiveness scope={scope} />
      <CalibrationSection scope={scope} />

      <Alert
        variant="light"
        color="info"
        role="note"
        title="The next two blocks do not follow the switch"
        data-testid="outside-scope-note"
      >
        Drift compares the forward results with the backtest, so it always uses forward results.
        News impact is measured on headlines, not on signals.
      </Alert>
      <DriftPanel />
      <NewsImpact />
    </Stack>
  );
}
