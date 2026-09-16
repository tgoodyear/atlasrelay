import { HttpResponseInit } from '@azure/functions';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
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
