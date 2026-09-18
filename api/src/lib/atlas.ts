import { HttpError } from './http';

/**
 * Minimal RIPE Atlas REST client for the two calls this platform needs.
 * Keys are passed per call and never stored. Errors are mapped to HttpErrors
 * that never contain the key.
 */

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when a call never reached RIPE, or RIPE never answered. The distinction matters for
 * transfers: every other error means RIPE replied with a refusal and no credits moved, whereas
 * this one means the outcome is unknown and the caller must not retry blindly.
 */
export class AtlasUnreachable extends HttpError {
  constructor(message: string) {
    super(502, message);
  }
}

/**
 * Thrown when RIPE answered and refused the request. The HTTP status we hand our own caller is
 * flattened (RIPE's 4xx becomes our 400), so RIPE's own status is kept here: it is the only way
 * to tell "this key lacks a permission" from "RIPE is having a bad day", and those two need
 * different words in front of a donor.
 */
export class AtlasRefused extends HttpError {
  constructor(public upstreamStatus: number, status: number, message: string) {
    super(status, message);
  }
}

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
  /** Whatever RIPE returned in the `transaction` field. In practice this is a filtered list URL
   *  such as .../credits/transactions/?sort=-date&type=admin, identical for every transfer and
   *  readable only with the donor's own key, so it is not a per-transfer reference. */
  transaction: string;
}

export interface CreditTransaction {
  id: number;
  type: string;
  amount: number;
  date: string;
  description?: string;
  balance_after?: number;
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
    throw new AtlasUnreachable(aborted ? 'RIPE Atlas did not respond in time' : 'Could not reach RIPE Atlas');
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
      return 'RIPE Atlas rejected the API key. Check that it carries "Transfer credits to another user", is enabled, and is within its validity window. The separate "Get information about your credits" permission is only used for the balance check and is not required.';
    case 429:
      return 'RIPE Atlas is rate-limiting requests. Wait a minute and try again.';
    default:
      return `RIPE Atlas returned HTTP ${status}.`;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    // The status line arrived but the connection died before the body did. For a transfer that is
    // the same situation as a timeout: RIPE may already have moved the credits. Raising the same
    // error the timeout raises keeps the caller's one question ("did RIPE answer?") answerable,
    // instead of letting a raw TypeError escape and be mistaken for a refusal.
    throw new AtlasUnreachable('RIPE Atlas closed the connection before its reply was complete');
  }
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
  // RIPE answered and refused, so no credits moved. Anything thrown from atlasFetch itself is
  // an AtlasUnreachable instead, and carries no such guarantee.
  if (!res.ok) throw new AtlasRefused(res.status, res.status === 429 ? 429 : 400, describeAtlasError(res.status, body));
  return body as CreditsOverview;
}

/**
 * Find the transaction RIPE recorded for a transfer we just made, so a pledge can carry a real
 * reference rather than the generic list URL the transfer endpoint returns. Needs the
 * "Get information about your credits" permission; returns null when that is absent or when no
 * matching row is found, in which case the caller records the transfer without an id.
 */
export async function findTransferTransaction(key: string, amount: number, since: number): Promise<CreditTransaction | null> {
  let res: Response;
  try {
    res = await atlasFetch('/credits/transactions/?sort=-date&type=admin&page_size=25', key);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await parseBody(res);
  } catch {
    // This lookup only ever adds a reference, and it runs after the transfer has completed, so it
    // must never raise anything the caller could mistake for a failed transfer.
    return null;
  }
  const rows: CreditTransaction[] = Array.isArray(body)
    ? (body as CreditTransaction[])
    : (((body as { results?: CreditTransaction[] } | null)?.results) ?? []);
  // A transfer out is recorded as a negative amount. Match the sign as well as the magnitude:
  // an incoming credit of the same size would otherwise be recorded as this transfer. If RIPE
  // ever records outgoing transfers differently we simply find nothing and store no id, which is
  // the right failure: no reference beats a wrong one.
  const candidates = rows.filter((row) => {
    if (row.amount !== -amount) return false;
    const when = Date.parse(row.date);
    return !Number.isFinite(when) || when + 5 * 60 * 1000 >= since;
  });
  // Amount and a time window do not uniquely identify a transfer. If the donor sent the same
  // amount twice in quick succession, or an unrelated transfer of that size landed in the window,
  // more than one row matches and there is no way to tell which is ours. Record nothing then: the
  // 201 already told us the credits moved, and a reference pointing at the wrong transaction is
  // worse than no reference at all.
  return candidates.length === 1 ? candidates[0] : null;
}

export async function transferCredits(key: string, recipient: string, amount: number): Promise<TransferResult> {
  const payload = JSON.stringify({ recipient, amount });
  // One POST only. The manual documents a singular path too, but the plural one is what the
  // live API serves, and re-posting a transfer to guess at a path could send credits twice.
  const res = await atlasFetch('/credits/transfers/', key, { method: 'POST', body: payload });
  const body = await parseBody(res);
  if (!res.ok) throw new AtlasRefused(res.status, res.status === 429 ? 429 : 400, describeAtlasError(res.status, body));
  const transaction = (body as TransferResult | null)?.transaction;
  // RIPE returns a list URL rather than a reference, so its absence is not worth failing on:
  // the 2xx is what tells us the credits moved.
  return { transaction: typeof transaction === 'string' ? transaction : '' };
}
