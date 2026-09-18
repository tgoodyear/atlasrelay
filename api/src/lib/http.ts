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
 * returned for the caller to log, because its message is not safe to publish: unknown errors can
 * carry request bodies, and a request body here contains an API key.
 */
export function markNotSent(err: unknown): unknown {
  if (!(err instanceof HttpError)) return new HttpError(500, 'Something went wrong before anything was sent, so no credits moved. Please try again.', NOT_SENT);
  if (err.details !== undefined) return err;
  return new HttpError(err.status, err.message, NOT_SENT);
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
      // Never echo unknown error objects: they might contain request bodies (API keys).
      const message = err instanceof Error ? err.message : 'Unexpected error';
      console.error('Unhandled error:', message);
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
