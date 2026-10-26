import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ProblemError } from '../http/problem';
import type { AuthService, AuthSession } from './service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard on every route that is not public; null on a public one. */
    session: AuthSession | null;
  }
}

/** `__Host-` makes a browser refuse the cookie unless it is `Secure`, has `Path=/` and has no `Domain` (01 section 8). */
export const SESSION_COOKIE = '__Host-vmgs_session';

const COOKIE_BASE = { path: '/', httpOnly: true, secure: true, sameSite: 'strict' } as const;

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: maxAgeSeconds });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, COOKIE_BASE);
}

/** The session of a request that passed the guard. A route that is not public always has one; if not, it fails closed. */
export function sessionOf(request: FastifyRequest): AuthSession {
  if (request.session === null) {
    throw new ProblemError(401, 'unauthenticated', 'There is no valid session.');
  }
  return request.session;
}

/**
 * Every route needs a valid session unless it says `public: true` (04 section 1); an address that is no route needs
 * one too, so that nobody can tell by the answer which addresses exist. A failure of the check is an error answer,
 * never an open door.
 */
export function registerAuthGuard(app: FastifyInstance, service: AuthService): void {
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config as { public?: boolean } | undefined;
    if (config?.public === true) return;

    const token = request.cookies[SESSION_COOKIE];
    const found = await service.authenticate(token);
    if (found === null || token === undefined) {
      // a cookie that is no good any more is of no use to the browser either
      if (token !== undefined) clearSessionCookie(reply);
      throw new ProblemError(401, 'unauthenticated', 'There is no valid session.');
    }
    request.session = found.session;
    if (found.cookieMaxAgeS !== null) setSessionCookie(reply, token, found.cookieMaxAgeS);
  });
}
