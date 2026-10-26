import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { ProblemError } from './problem';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Only a route that says so is open to a visitor without a session (see `registerAuthGuard`). */
    public?: boolean;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteContext<P, B, Q = undefined> {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly params: P;
  readonly body: B;
  readonly query: Q;
}

interface RouteBase<P, B, Q = undefined> {
  readonly method: Method;
  readonly url: string;
  /** Without this the route needs a session. There is no other way to open a route. */
  readonly public?: true;
  readonly params?: z.ZodType<P>;
  readonly body?: z.ZodType<B>;
  /** The query string; a name the contract does not know is a 400, like a wrong value. */
  readonly query?: z.ZodType<Q>;
}

/** A route that answers 200 with JSON that must match its contract. */
export interface JsonRoute<P, B, R, Q = undefined> extends RouteBase<P, B, Q> {
  readonly response: z.ZodType<R>;
  readonly handler: (context: RouteContext<P, B, Q>) => Promise<R>;
}

/** A route that answers 204. */
export interface EmptyRoute<P, B, Q = undefined> extends RouteBase<P, B, Q> {
  readonly handler: (context: RouteContext<P, B, Q>) => Promise<void>;
}

/** The fields that are wrong, never their values (a password may be among them). */
function badFields(error: z.ZodError): string {
  const paths = new Set(error.issues.map((issue) => issue.path.join('.') || '(body)'));
  return `The request does not match the contract: ${[...paths].join(', ')}.`;
}

function parseInput<T>(schema: z.ZodType<T> | undefined, value: unknown): T {
  if (schema === undefined) return undefined as T;
  const result = schema.safeParse(value);
  if (!result.success) throw new ProblemError(400, 'invalid_request', badFields(result.error));
  return result.data;
}

function register<P, B, Q>(
  app: FastifyInstance,
  spec: RouteBase<P, B, Q>,
  run: (context: RouteContext<P, B, Q>) => Promise<void>,
): void {
  app.route({
    method: spec.method,
    url: spec.url,
    config: { public: spec.public === true },
    handler: async (request, reply) => {
      const params = parseInput(spec.params, request.params);
      const body = parseInput(spec.body, request.body);
      const query = parseInput(spec.query, request.query);
      await run({ request, reply, params, body, query });
      return reply;
    },
  });
}

/** Registers a route with a contract for its input and its answer: a mismatch is a 400, or a 500 for the answer. */
export function jsonRoute<P = undefined, B = undefined, R = undefined, Q = undefined>(
  app: FastifyInstance,
  spec: JsonRoute<P, B, R, Q>,
): void {
  register(app, spec, async (context) => {
    const result = spec.response.parse(await spec.handler(context));
    // 200 unless the handler chose another status for this answer (a not-ready probe answers 503)
    await context.reply.send(result);
  });
}

export function emptyRoute<P = undefined, B = undefined, Q = undefined>(
  app: FastifyInstance,
  spec: EmptyRoute<P, B, Q>,
): void {
  register(app, spec, async (context) => {
    await spec.handler(context);
    await context.reply.code(204).send();
  });
}
