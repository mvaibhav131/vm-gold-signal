import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  loginRequestSchema,
  meResponseSchema,
  passwordChangeRequestSchema,
  sessionsResponseSchema,
  totpCodeRequestSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from '@vmgs/contracts';

import { emptyRoute, jsonRoute } from '../http/route';
import { SESSION_COOKIE, clearSessionCookie, sessionOf, setSessionCookie } from './guard';
import type { AuthService, ClientInfo } from './service';

export const AUTH_BASE = '/api/v1/auth';

function clientOf(request: FastifyRequest): ClientInfo {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

/** The routes of 04 section 2 (Auth). There is no registration and no "forgot password": the owner is made, and reset, on the server (`pnpm api:cli`). */
export function registerAuthRoutes(app: FastifyInstance, service: AuthService): void {
  // The only route that is open. A login always starts a new session: one the browser still holds is ended.
  emptyRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/login`,
    public: true,
    body: loginRequestSchema,
    handler: async ({ request, reply, body }) => {
      const logged = await service.login(body, clientOf(request));
      await service.endToken(request.cookies[SESSION_COOKIE]);
      setSessionCookie(reply, logged.token, logged.cookieMaxAgeS);
    },
  });

  emptyRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/logout`,
    handler: async ({ request, reply }) => {
      await service.logout(sessionOf(request), clientOf(request));
      clearSessionCookie(reply);
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${AUTH_BASE}/me`,
    response: meResponseSchema,
    handler: ({ request }) => service.me(sessionOf(request)),
  });

  emptyRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/password`,
    body: passwordChangeRequestSchema,
    handler: ({ request, body }) =>
      service.changePassword(sessionOf(request), body, clientOf(request)),
  });

  jsonRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/totp/setup`,
    response: totpSetupResponseSchema,
    handler: ({ request }) => service.totpSetup(clientOf(request)),
  });

  jsonRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/totp/enable`,
    body: totpCodeRequestSchema,
    response: totpEnableResponseSchema,
    handler: ({ request, body }) => service.totpEnable(body.code, clientOf(request)),
  });

  emptyRoute(app, {
    method: 'POST',
    url: `${AUTH_BASE}/totp/disable`,
    body: totpCodeRequestSchema,
    handler: ({ request, body }) => service.totpDisable(body.code, clientOf(request)),
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${AUTH_BASE}/sessions`,
    response: sessionsResponseSchema,
    handler: ({ request }) => service.sessions(sessionOf(request)),
  });

  emptyRoute(app, {
    method: 'DELETE',
    url: `${AUTH_BASE}/sessions/:id`,
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    handler: async ({ request, reply, params }) => {
      const ended = await service.revokeSession(sessionOf(request), params.id, clientOf(request));
      // ending the session in use is a logout
      if (ended.current) clearSessionCookie(reply);
    },
  });
}
