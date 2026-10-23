import { AppShell, Box, Group, Stack, Text } from '@mantine/core';
import { NavLink, Outlet } from 'react-router';

import { NAV_ENTRIES } from './nav';
import { StatusBar } from './StatusBar';

/**
 * The frame of every private screen. Desktop: navigation rail on the left. Phone: tab bar at the
 * bottom. The status bar stays on top of the content in both (05_UI_Spec section 2).
 */
export function AppLayout() {
  return (
    <AppShell
      navbar={{ width: 132, breakpoint: 'sm', collapsed: { mobile: true } }}
      footer={{ height: { base: 64, sm: 0 } }}
      padding="md"
    >
      <a className="skip-link" href="#page">
        Skip to content
      </a>

      <AppShell.Navbar p="xs" visibleFrom="sm">
        <Stack gap="md">
          <Text fw={700} c="gold.5" px="xs" pt="xs">
            VM Gold Signal
          </Text>
          <nav aria-label="Main navigation">
            <Stack gap={4}>
              {NAV_ENTRIES.map((entry) => (
                <NavLink key={entry.to} to={entry.to} end={entry.end ?? false} className="nav-item">
                  {entry.label}
                </NavLink>
              ))}
            </Stack>
          </nav>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <StatusBar />
        <Box id="page" tabIndex={-1}>
          <Outlet />
        </Box>
      </AppShell.Main>

      <AppShell.Footer hiddenFrom="sm" p={4}>
        <nav aria-label="Main navigation, bottom tabs">
          <Group grow gap={2} wrap="nowrap">
            {NAV_ENTRIES.map((entry) => (
              <NavLink key={entry.to} to={entry.to} end={entry.end ?? false} className="tab-item">
                {entry.label}
              </NavLink>
            ))}
          </Group>
        </nav>
      </AppShell.Footer>
    </AppShell>
  );
}
