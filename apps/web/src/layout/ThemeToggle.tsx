import { ActionIcon, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';

import { MoonIcon, SunIcon } from '../icons';

/** Dark and light theme switch. The choice is saved in the browser and kept after a reload. */
export function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const next = scheme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;

  return (
    <ActionIcon
      variant="default"
      size="lg"
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      onClick={() => {
        setColorScheme(next);
      }}
    >
      {scheme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </ActionIcon>
  );
}
