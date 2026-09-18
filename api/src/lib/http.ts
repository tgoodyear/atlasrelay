import { HttpResponseInit } from '@azure/functions';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Attached to an error when the request is certain no transfer was issued, so the browser can keep
 * the form live for a retry. Inferring this from the HTTP status does not work in either
 * direction: a 503 raised inside a handler means nothing was sent, while a 503 from the platform
 * edge can arrive over a transfer that was already in flight. Only the handler knows, so it says
 * so. Read by the web client as details.transfer === 'not-sent'.
 */
export const NOT_SENT = { transfer: 'not-sent' as const };

/**
 * Label an error as raised before anything irreversible was attempted.
 *
 * Only ever adds the marker, never changes one: an error that already carries details is saying
 * something more specific and keeps it.
 *
 * Anything that is not an HttpError is an unexpected failure, and handle() would turn it into a
 * bare 500 with no details at all. That is the wrong answer here for the same reason the marker
 * exists: with no marker the browser shows the outcome-unknown screen, so a storage rejection on
 * the way to a transfer told the donor to go and check their RIPE account before sending again,
 * over a request that never reached RIPE. It becomes a 500 that says so instead. The original is
 * not returned and not quoted: its message is unsafe to publish, because an unknown error can carry
 * the request body and a request body here contains an API key. Callers that want it in the log
 * must do that themselves, before calling this, and through describeErrorForLog.
 */
export function markNotSent(err: unknown): unknown {
  if (!(err instanceof HttpError)) return new HttpError(500, 'Something went wrong before anything was sent, so no credits moved. Please try again.', NOT_SENT);
  if (err.details !== undefined) return err;
  return new HttpError(err.status, err.message, NOT_SENT);
}

/**
 * How an unexpected error may be written to a log.
 *
 * Never its message. SECURITY.md promises a pasted API key cannot reach a log, and an unknown
 * error is unknown: whatever threw it may have folded the request body, which on the pledge route
 * carries the donor's key, into free text. Two places here previously said that in a comment and
 * then logged the message anyway.
 *
 * What is left is still enough to work with, because the errors that actually reach these paths
 * are Azure storage errors: the class name, the service's own error code, and the HTTP status are
 * all fixed identifiers chosen by the SDK rather than anything derived from the request.
 */
export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const { code, statusCode } = err as { code?: unknown; statusCode?: unknown };
  const parts = [err.name || 'Error'];
  if (typeof code === 'string') parts.push(`code=${code}`);
  if (typeof statusCode === 'number') parts.push(`status=${statusCode}`);
  return parts.join(' ');
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponseInit {
  return {
    status,
    jsonBody: body,
    headers: { 'cache-control': 'no-store', ...headers },
  };
}

export function noContent(): HttpResponseInit {
  return { status: 204 };
}

/** Wrap a handler so thrown HttpErrors become JSON responses and anything else a 500. */
export function handle<TArgs extends unknown[]>(fn: (...args: TArgs) => Promise<HttpResponseInit>) {
  return async (...args: TArgs): Promise<HttpResponseInit> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { status: err.status, message: err.message, details: err.details } }, err.status);
      }
      // Never echo unknown error objects, to the client or to the log: they might contain request
      // bodies, and on the pledge route a request body holds the donor's API key. This used to log
      // err.message, one line under a comment saying not to.
      console.error('Unhandled error:', describeErrorForLog(err));
      return json({ error: { status: 500, message: 'Internal error' } }, 500);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: { text(): Promise<string> }): Promise<T> {
  const raw = await req.text();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}
