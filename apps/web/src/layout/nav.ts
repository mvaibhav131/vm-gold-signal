export interface NavEntry {
  to: string;
  label: string;
  /** Match only the exact path (the dashboard lives at "/"). */
  end?: boolean;
}

/** The five main screens, in the order of the mobile tab bar (05_UI_Spec section 2). */
export const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/signals', label: 'Signals' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/news', label: 'News' },
  { to: '/system', label: 'System' },
];
