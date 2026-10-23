import { useState } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import type { ApiClient } from './api/client';
import { AppProviders } from './AppProviders';
import { appRoutes } from './routes';

export function App({ client }: { client: ApiClient }) {
  const [router] = useState(() => createBrowserRouter(appRoutes));
  return (
    <AppProviders client={client}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
