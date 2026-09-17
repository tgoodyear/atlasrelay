import { HttpError } from './http';

/**
 * Minimal RIPE Atlas REST client for the two calls this platform needs.
 * Keys are passed per call and never stored. Errors are mapped to HttpErrors
 * that never contain the key.
 */

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function base(): string {
  return (process.env.ATLAS_API_BASE || 'https://atlas.ripe.net/api/v2').replace(/\/$/, '');
}

export function assertKeyFormat(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key.trim())) {
    throw new HttpError(400, 'API key must be a RIPE Atlas key (UUID format)');
  }
  return key.trim();
}

export interface AtlasError {
  status: number;
  title?: string;
  detail?: string;
  errors?: { source?: { pointer?: string; parameter?: string }; detail?: string }[];
}

export interface CreditsOverview {
  current_balance: number;
  estimated_daily_income?: number;
  estimated_daily_expenditure?: number;
  estimated_runout_seconds?: number | null;
  past_day_credits_spent?: number;
}

export interface TransferResult {
  transaction: string;
}

async function atlasFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Key ${key}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new HttpError(502, aborted ? 'RIPE Atlas did not respond in time' : 'Could not reach RIPE Atlas');
  } finally {
    clearTimeout(timer);
  }
}

/** Convert a RIPE error body into a user-facing message. Exported for tests. */
export function describeAtlasError(status: number, body: unknown): string {
  const err = (body as { error?: AtlasError } | null)?.error;
  const parts: string[] = [];
  if (err?.detail) parts.push(err.detail);
  for (const e of err?.errors ?? []) {
    const where = e.source?.pointer?.replace(/^\//, '') || e.source?.parameter;
    if (e.detail) parts.push(where ? `${where}: ${e.detail}` : e.detail);
  }
  if (parts.length) return parts.join(' ');
  switch (status) {
    case 401:
    case 403:
      return 'RIPE Atlas rejected the API key. Check that it carries both "Transfer credits to another user" and "Get information about your credits", is enabled, and is within its validity window.';
    case 429:
      return 'RIPE Atlas is rate-limiting requests. Wait a minute and try again.';
    default:
      return `RIPE Atlas returned HTTP ${status}.`;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getCredits(key: string): Promise<CreditsOverview> {
  const res = await atlasFetch('/credits/', key);
  const body = await parseBody(res);
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 400, describeAtlasError(res.status, body));
  return body as CreditsOverview;
}

export async function transferCredits(key: string, recipient: string, amount: number): Promise<TransferResult> {
  const payload = JSON.stringify({ recipient, amount });
  let res = await atlasFetch('/credits/transfers/', key, { method: 'POST', body: payload });
  if (res.status === 404) {
    // The manual documents the singular path; the reference documents the plural.
    res = await atlasFetch('/credits/transfer/', key, { method: 'POST', body: payload });
  }
  const body = await parseBody(res);
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 400, describeAtlasError(res.status, body));
  const transaction = (body as TransferResult | null)?.transaction;
  if (typeof transaction !== 'string') throw new HttpError(502, 'RIPE Atlas accepted the transfer but returned no transaction reference');
  return { transaction };
}
