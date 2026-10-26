import type { ApiClient } from './client';

/**
 * The client of this build. `VITE_DATA_SOURCE=live` is the API of the server; anything else is the mock data of the
 * preview (phases U0 to U4). It lives apart from `client.ts` so that the contract of the client has no Vite in it: the
 * API's tests load the live client too.
 */
export async function loadApiClient(): Promise<ApiClient> {
  if (import.meta.env.VITE_DATA_SOURCE === 'live') {
    // A live build never loads the mock data: the other branch is cut out when the build knows the data source.
    const { createHttpClient } = await import('./httpClient');
    return createHttpClient();
  } else {
    const { createMockClient } = await import('../mocks/mockClient');
    return createMockClient();
  }
}
