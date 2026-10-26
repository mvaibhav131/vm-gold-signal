import type { FastifyInstance } from 'fastify';

import { settingsPatchSchema, settingsSchema } from '@vmgs/contracts';

import { jsonRoute } from '../http/route';
import { ProblemError } from '../http/problem';
import { SettingsConflictError, type SettingsStore } from './store';

const API_BASE = '/api/v1';

export interface SettingsDeps {
  readonly store: SettingsStore;
  readonly now: () => number;
}

/** `GET` and `PATCH /settings` (04 section 2). The settings are the six keys of `app_settings` and nothing else. */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/settings`,
    response: settingsSchema,
    handler: () => deps.store.read(),
  });

  jsonRoute(app, {
    method: 'PATCH',
    url: `${API_BASE}/settings`,
    body: settingsPatchSchema,
    response: settingsSchema,
    handler: async ({ body }) => {
      try {
        return await deps.store.patch(body, deps.now());
      } catch (error) {
        // the code of the auth routes for a change that lost a race: nothing was done, try again
        if (error instanceof SettingsConflictError) {
          throw new ProblemError(
            409,
            'conflict',
            'The settings were changed at the same moment, so nothing was saved. Try again.',
          );
        }
        throw error;
      }
    },
  });
}
