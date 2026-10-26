import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { registerAuthGuard } from './auth/guard';
import { registerAuthRoutes } from './auth/routes';
import type { AuthService } from './auth/service';
import { registerProblemHandlers } from './http/problem';
import { registerSecurityHooks } from './http/security';

export interface AppOptions {
  readonly service: AuthService;
  /** `https://vmgs-yourname.duckdns.org`: the only origin that may change anything (04 section 1). */
  readonly siteOrigin: string;
  readonly logger?: FastifyServerOptions['logger'];
  /** How many proxies stand in front of the API (Caddy is one): the client address is the one that many hops back. */
  readonly trustedProxyHops?: number;
  /** Routes of the later phases; they are registered after the guard, so they need a session unless they say otherwise. */
  readonly routes?: (app: FastifyInstance) => void;
}

export interface RouteInfo {
  readonly method: string;
  readonly url: string;
  readonly public: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route that was registered, with whether it is open to a visitor. The security tests walk it. */
    routeTable: readonly RouteInfo[];
    /** Whether the session of a cookie value still stands, without using it (a stream asks this while it is open). */
    sessionStillValid(token: string | undefined): Promise<boolean>;
  }
}

/** A body is a few hundred bytes at most (a login, a settings patch). */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The API: problem+json for every error, the headers and the Origin check on every answer, then the guard (a session
 * for everything unless a route says it is public), then the routes. The order of the registrations is the order the
 * hooks run in.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const hops = options.trustedProxyHops ?? 0;
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 64 },
  });

  const table: RouteInfo[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const config = route.config as { public?: boolean } | undefined;
    for (const method of methods) {
      table.push({ method, url: route.url, public: config?.public === true });
    }
  });
  app.decorate('routeTable', table);
  app.decorate('sessionStillValid', (token: string | undefined) =>
    options.service.stillValid(token),
  );

  await app.register(cookie);
  registerProblemHandlers(app);
  registerSecurityHooks(app, options.siteOrigin);

  // Only JSON is read (the default parsers also take plain text, which no route of the API wants: 415 instead).
  // An empty body with `Content-Type: application/json` (a POST that has nothing to say) is no body, not an error.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    void parseJson(request, body as string, done);
  });

  registerAuthGuard(app, options.service);
  registerAuthRoutes(app, options.service);
  options.routes?.(app);
  return app;
}
