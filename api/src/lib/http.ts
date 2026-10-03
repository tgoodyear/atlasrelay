import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { logError } from './telemetry';

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

// Kept importable from here, where its callers have always found it; it lives with the logger.
export { describeErrorForLog } from './telemetry';

/**
 * Set on every API response. The Function App sits behind SWA as a linked backend, and SWA does
 * not add staticwebapp.config.json's globalHeaders to those responses, so the API sets this itself.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = { 'x-content-type-options': 'nosniff' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponseInit {
  return {
    status,
    jsonBody: body,
    headers: { 'cache-control': 'no-store', ...headers, ...API_SECURITY_HEADERS },
  };
}

export function noContent(): HttpResponseInit {
  return { status: 204, headers: { ...API_SECURITY_HEADERS } };
}

/** Add API_SECURITY_HEADERS to a response whatever form its headers were given in. */
function withSecurityHeaders(res: HttpResponseInit): HttpResponseInit {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) headers.set(k, v);
  return { ...res, headers: Object.fromEntries(headers) };
}

/** Methods that send no body and are meant to change nothing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The media type of a Content-Type header, without parameters, lower-cased. '' when absent. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Refuse a request a browser sent on another site's behalf.
 *
 * Sec-Fetch-Site, when the browser sends it, must be same-origin, on every method. Some GET
 * handlers write too (GET /api/me creates the profile row, and the project and dashboard reads
 * tidy up expired rows), so GET is not exempt. A GET or HEAD may also carry 'none', which a
 * browser sends for a request the user started directly, such as a typed URL or a bookmark: no
 * other site can cause it, and it lets someone open /api/stats in a tab. same-site (another host
 * under the same registrable domain) and cross-site are refused. Clients that are not browsers
 * (curl, Playwright's request API) do not send the header and are judged on the rest alone.
 *
 * Every other method must also say Content-Type: application/json (parameters such as charset
 * are allowed). A cross-site HTML form can only send text/plain, multipart/form-data or
 * application/x-www-form-urlencoded, and a cross-site fetch() that sets application/json needs a
 * CORS preflight, which this API never grants. So a write that passes could not have come from
 * another site's page without the browser asking first, even from a browser that sends no
 * Sec-Fetch-Site. For those methods 'none' is refused as well: no navigation is a legitimate way
 * to call a mutating JSON endpoint, since the site's own pages always use fetch().
 *
 * The Content-Type rule holds for requests with no body too, DELETE /api/me included, rather than
 * exempting them. A body-less cross-site POST is not safe to exempt: fetch(url, { method: 'POST',
 * mode: 'no-cors' }) sends one with the user's cookies and no Content-Type at all. A body-less
 * DELETE is safe today only because browsers preflight DELETE, and one uniform rule is easier to
 * keep right than a list of exceptions. Static Web Apps drops the Content-Type of a request with no
 * body before it reaches the API, so web/src/lib/api.ts and the test harnesses send a JSON body on
 * every mutating call, `{}` when there is nothing to send.
 */
export function assertSameOriginWrite(req: Pick<HttpRequest, 'method' | 'headers'>): void {
  const method = req.method.toUpperCase();
  const safe = SAFE_METHODS.has(method);
  const site = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site !== undefined && site !== 'same-origin' && !(site === 'none' && (method === 'GET' || method === 'HEAD'))) {
    throw new HttpError(403, 'Cross-site requests are not accepted');
  }
  if (safe) return;
  if (mediaType(req.headers.get('content-type')) !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
}

/**
 * Wrap a handler so thrown HttpErrors become JSON responses and anything else a 500. Every API
 * route goes through here, so this is also where assertSameOriginWrite runs, before the handler
 * reads auth, the body or storage.
 */
export function handle(fn: (req: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>) {
  return async (req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      assertSameOriginWrite(req);
      return withSecurityHeaders(await fn(req, context));
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { status: err.status, message: err.message, details: err.details } }, err.status);
      }
      // Never echo unknown error objects, to the client or to the log: they might contain request
      // bodies, and on the pledge route a request body holds the donor's API key. This used to log
      // err.message, one line under a comment saying not to.
      logError('Unhandled error', err);
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
