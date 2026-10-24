import { Stack, Tabs, Text, Title } from '@mantine/core';
import { useSearchParams } from 'react-router';

import { usePageTitle } from '../hooks';
import { AlertsTab } from './AlertsTab';
import { DisplayTab } from './DisplayTab';
import { HealthTab } from './HealthTab';
import { SecurityTab } from './SecurityTab';
import { StorageTab } from './StorageTab';
import { StrategiesTab } from './StrategiesTab';

export const SYSTEM_TABS = [
  'health',
  'storage',
  'strategies',
  'alerts',
  'display',
  'security',
] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

const TAB_LABELS: Readonly<Record<SystemTab, string>> = {
  health: 'Health',
  storage: 'Storage',
  strategies: 'Strategies',
  alerts: 'Alerts',
  display: 'Display',
  security: 'Security',
};

/** The tab is in the address (`/system?tab=alerts`), so a link opens it; an unknown value means the first tab. */
export function systemTabFromParams(params: URLSearchParams): SystemTab {
  return SYSTEM_TABS.find((tab) => tab === params.get('tab')) ?? 'health';
}

/**
 * System and settings (`/system`, 05_UI_Spec section 8): health, storage, strategies, alerts,
 * display and security. A risky action (pause the engine, switch off a strategy, revoke a
 * session) asks first.
 */
export default function SystemPage() {
  usePageTitle('System');
  const [params, setParams] = useSearchParams();
  const tab = systemTabFromParams(params);
  return (
    <Stack gap="md" data-testid="page-system">
      <Stack gap={4}>
        <Title order={1} size="h2">
          System
        </Title>
        <Text c="dimmed" size="sm" maw={760}>
          How the system is doing, how much it stores, and your settings. Changes are saved as you
          make them.
        </Text>
      </Stack>

      <Tabs
        value={tab}
        onChange={(value) => {
          const next = new URLSearchParams(params);
          if (value === null || value === 'health') next.delete('tab');
          else next.set('tab', value);
          setParams(next, { replace: true });
        }}
        keepMounted={false}
      >
        <Tabs.List className="tabs-scroll" aria-label="System sections">
          {SYSTEM_TABS.map((key) => (
            <Tabs.Tab key={key} value={key}>
              {TAB_LABELS[key]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="health" pt="md">
          <HealthTab />
        </Tabs.Panel>
        <Tabs.Panel value="storage" pt="md">
          <StorageTab />
        </Tabs.Panel>
        <Tabs.Panel value="strategies" pt="md">
          <StrategiesTab />
        </Tabs.Panel>
        <Tabs.Panel value="alerts" pt="md">
          <AlertsTab />
        </Tabs.Panel>
        <Tabs.Panel value="display" pt="md">
          <DisplayTab />
        </Tabs.Panel>
        <Tabs.Panel value="security" pt="md">
          <SecurityTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
