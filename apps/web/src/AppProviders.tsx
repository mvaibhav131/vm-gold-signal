import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import type { ApiClient } from './api/client';
import { ApiContext } from './api/context';
import { theme, cssVariablesResolver } from './theme';

export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );

  // Dark by default (05_UI_Spec section 1); the owner can switch to light and the choice is kept.
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <QueryClientProvider client={queryClient}>
        <ApiContext value={client}>{children}</ApiContext>
      </QueryClientProvider>
    </MantineProvider>
  );
}
