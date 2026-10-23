import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import type { ApiClient } from './api/client';
import { ApiContext } from './api/context';
import { theme } from './theme';

export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <ApiContext value={client}>{children}</ApiContext>
      </QueryClientProvider>
    </MantineProvider>
  );
}
