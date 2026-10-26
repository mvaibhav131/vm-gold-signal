import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

import { PROBLEM_CONTENT_TYPE, problemSchema, type Problem } from '@vmgs/contracts';

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** An error the API answers on purpose: a status, a stable machine `code` and a sentence for a person. */
export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, detail: string, headers: Record<string, string> = {}) {
    super(detail);
    this.name = 'ProblemError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** The RFC 9457 body of an answer. `about:blank` is the type for a problem that needs no more than its status. */
export function problemOf(status: number, code: string, detail: string): Problem {
  return problemSchema.parse({
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    code,
    detail,
  });
}

export function sendProblem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  headers: Readonly<Record<string, string>> = {},
): FastifyReply {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problemOf(status, code, detail));
}

/** What Fastify itself refuses before a handler runs, in the words of the contract. */
function fastifyProblem(error: FastifyError): { status: number; code: string; detail: string } {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { status: 413, code: 'payload_too_large', detail: 'The request body is too large.' };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        status: 415,
        code: 'unsupported_media_type',
        detail: 'Only application/json is accepted.',
      };
    default:
      return { status: 400, code: 'invalid_request', detail: 'The request could not be read.' };
  }
}

/** Every error and every unknown address leaves as problem+json; an unexpected error shows nothing of itself. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ProblemError, request, reply) => {
    if (error instanceof ProblemError) {
      sendProblem(reply, error.status, error.code, error.message, error.headers);
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const problem = fastifyProblem(error);
      sendProblem(reply, problem.status, problem.code, problem.detail);
      return;
    }
    request.log.error({ err: error }, 'the request failed');
    sendProblem(reply, 500, 'server_error', 'The server failed to answer.');
  });

  app.setNotFoundHandler((_request, reply) => {
    sendProblem(reply, 404, 'not_found', 'There is nothing at this address.');
  });
}
