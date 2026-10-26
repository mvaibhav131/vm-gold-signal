import type { FastifyRequest, FastifyServerOptions } from 'fastify';

type LoggerOptions = Extract<NonNullable<FastifyServerOptions['logger']>, object>;

/**
 * The logger of the API process (01_HLD section 8.1): no cookie, no CSRF header, and no address of a client. The default
 * serializer of a request would write `remoteAddress` (with `API_TRUSTED_PROXY_HOPS=1`, the owner's real address) and
 * the port; an address is only ever kept as a keyed hash, by the login throttle. What a request line holds is what
 * happened: the method, the path, the status, the time.
 */
export function apiLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: ['req.headers.cookie', 'req.headers["x-vmgs-csrf"]', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: request.url,
      }),
    },
  };
}
