import { Center, Loader } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useApi } from '../api/context';

export const ME_KEY = ['me'] as const;

/** A private route: without a valid session the visitor is sent to /login. Never open by default. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const api = useApi();
  const location = useLocation();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api.me() });

  if (me.isPending) {
    return (
      <Center mih="100vh" role="status" aria-label="Checking your session">
        <Loader />
      </Center>
    );
  }
  if (me.isError || me.data === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
