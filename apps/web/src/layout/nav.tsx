import type { ReactNode } from 'react';

import { AnalyticsIcon, DashboardIcon, NewsIcon, SignalsIcon, SystemIcon } from '../icons';

export interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /** Match only the exact path (the dashboard lives at "/"). */
  end?: boolean;
}

/** The five main screens, in the order of the mobile tab bar (05_UI_Spec section 2). */
export const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: <DashboardIcon />, end: true },
  { to: '/signals', label: 'Signals', icon: <SignalsIcon /> },
  { to: '/analytics', label: 'Analytics', icon: <AnalyticsIcon /> },
  { to: '/news', label: 'News', icon: <NewsIcon /> },
  { to: '/system', label: 'System', icon: <SystemIcon /> },
];
