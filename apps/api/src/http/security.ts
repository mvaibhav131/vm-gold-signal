import type { FastifyInstance } from 'fastify';

import { ProblemError } from './problem';

/** Headers of every answer: the API sends JSON only, so nothing here may be framed, sniffed, cached or run. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const CSRF_HEADER = 'x-vmgs-csrf';

/**
 * A state-changing request must come from the site itself (04 section 1): the `Origin` header is the site origin
 * and the custom header is there. A form on another site cannot set that header, and a script on another site is
 * refused by `Origin` (and by `SameSite=Strict` on the cookie). `Sec-Fetch-Site`, when the browser sends it, must
 * say the same.
 */
export function checkSameSite(
  method: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  siteOrigin: string,
): void {
  if (!UNSAFE_METHODS.has(method)) return;
  const fetchSite = headers['sec-fetch-site'];
  const refused =
    headers.origin !== siteOrigin ||
    headers[CSRF_HEADER] !== '1' ||
    (fetchSite !== undefined && fetchSite !== 'same-origin');
  if (refused) {
    throw new ProblemError(
      403,
      'csrf_rejected',
      'This request did not come from the site (Origin and X-VMGS-CSRF are required).',
    );
  }
}

/** The origin must be exactly scheme and host (and port), as a browser writes it in `Origin`. */
export function parseSiteOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin === 'null' || url.origin !== value) {
    throw new Error('the site origin must be scheme, host and port only, like https://example.org');
  }
  return url.origin;
}

export function registerSecurityHooks(app: FastifyInstance, siteOrigin: string): void {
  app.addHook('onRequest', (request, reply, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    try {
      checkSameSite(request.method, request.headers, siteOrigin);
    } catch (error) {
      done(error as Error);
      return;
    }
    done();
  });
}
