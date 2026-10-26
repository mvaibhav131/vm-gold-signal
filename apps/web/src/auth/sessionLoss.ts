import type { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { ME_KEY } from './RequireAuth';

/**
 * The server says there is no valid session: it ended, was revoked from another device, or ran out. A refused login is also a
 * 401 (`invalid_credentials`) and is not this: the login form shows its own error.
 */
export function isSessionLost(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'unauthenticated';
}

/**
 * Called for every query and mutation that failed. When the session is gone the owner is told so, and the private screens send
 * the visitor to the login (`RequireAuth` reads this answer); without it a page would show "Retrying" for ever.
 */
export function endSessionIfLost(queryClient: QueryClient, error: unknown): void {
  if (isSessionLost(error)) queryClient.setQueryData(ME_KEY, null);
}

/** Everything that was loaded with an earlier session: a new login starts from nothing but the answer about itself. */
export function forgetPrivateData(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY[0] });
}
