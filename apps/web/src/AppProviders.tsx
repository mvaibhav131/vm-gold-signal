import { MantineProvider } from '@mantine/core';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import type { ApiClient } from './api/client';
import { ApiContext } from './api/context';
import { endSessionIfLost } from './auth/sessionLoss';
import { theme, cssVariablesResolver } from './theme';

export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [queryClient] = useState(() => {
    const made: QueryClient = new QueryClient({
      // a request that finds the session gone sends the visitor to the login (see `sessionLoss.ts`)
      queryCache: new QueryCache({
        onError: (error) => {
          endSessionIfLost(made, error);
        },
      }),
      mutationCache: new MutationCache({
        onError: (error) => {
          endSessionIfLost(made, error);
        },
      }),
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    return made;
  });

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
