import { AppShell, Box, Group, Stack, Text } from '@mantine/core';
import { NavLink, Outlet } from 'react-router';

import { useApi } from '../api/context';
import { useStreamBridge } from '../data/stream';
import { FeedBanner } from './FeedBanner';
import { NAV_ENTRIES } from './nav';
import { StatusBar } from './StatusBar';

/**
 * The frame of every private screen. Desktop: navigation rail on the left. Phone: tab bar at the
 * bottom. The status bar stays on top of the content in both (05_UI_Spec section 2).
 */
export function AppLayout() {
  const api = useApi();
  useStreamBridge();

  return (
    <AppShell
      navbar={{ width: { sm: 200, lg: 232 }, breakpoint: 'sm', collapsed: { mobile: true } }}
      footer={{ height: { base: 68, sm: 0 } }}
      padding="md"
    >
      <a className="skip-link" href="#page">
        Skip to content
      </a>

      <AppShell.Navbar p="md" visibleFrom="sm">
        <Stack gap="xl" h="100%" justify="space-between">
          <Stack gap="lg">
            <div className="brand-block">
              <span className="brand">VM Gold Signal</span>
              <span className="brand-caption">XAU/USD decision support</span>
            </div>
            <nav aria-label="Main navigation">
              <Stack gap={4}>
                {NAV_ENTRIES.map((entry) => (
                  <NavLink
                    key={entry.to}
                    to={entry.to}
                    end={entry.end ?? false}
                    className="nav-item"
                  >
                    <span className="nav-icon">{entry.icon}</span>
                    <span>{entry.label}</span>
                  </NavLink>
                ))}
              </Stack>
            </nav>
          </Stack>
          {api.kind === 'mock' && (
            <Text size="xs" c="dimmed">
              Preview mode: every number on screen is simulated.
            </Text>
          )}
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <StatusBar />
        <FeedBanner />
        <Box id="page" tabIndex={-1} className="page">
          <Outlet />
        </Box>
      </AppShell.Main>

      <AppShell.Footer hiddenFrom="sm" p={4}>
        <nav aria-label="Main navigation, bottom tabs">
          <Group grow gap={2} wrap="nowrap">
            {NAV_ENTRIES.map((entry) => (
              <NavLink key={entry.to} to={entry.to} end={entry.end ?? false} className="tab-item">
                <span className="nav-icon">{entry.icon}</span>
                <span>{entry.label}</span>
              </NavLink>
            ))}
          </Group>
        </nav>
      </AppShell.Footer>
    </AppShell>
  );
}
