// The RIPE Atlas calls the real-transfer tests (specs/ripe-transfer.spec.ts) make from inside the
// job with the two test keys: read a balance, check what a key may do, and send the return leg of
// a transfer. Plain fetch, like the site's own client (api/src/lib/atlas.ts).
//
// Nothing here prints, returns or throws a key. Errors carry the call, the HTTP status and RIPE's
// own message, and run.mjs redacts the output on top of that.

export const DEFAULT_BASE = 'https://atlas.ripe.net/api/v2';

export class RipeError extends Error {
  /**
   * @param {string} message
   * @param {number} status the HTTP status, or 0 when RIPE did not answer
   */
  constructor(message, status) {
    super(message);
    this.name = 'RipeError';
    this.status = status;
  }
}

/** @param {unknown} body */
function detail(body) {
  const err = /** @type {{ error?: { detail?: string, title?: string, errors?: { detail?: string }[] } } | null} */ (body)?.error;
  const parts = [err?.detail, ...(err?.errors ?? []).map((e) => e.detail)].filter(Boolean);
  return parts.length ? `: ${parts.join(' ')}` : err?.title ? `: ${err.title}` : '';
}

/**
 * @param {string} key a RIPE Atlas API key
 * @param {{ label: string, base?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 *   label names the key in messages, e.g. "the donor key (ripe-donor-key)"
 */
export function ripeClient(key, opts) {
  const base = (opts.base ?? process.env.E2E_RIPE_API_BASE ?? DEFAULT_BASE).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const label = opts.label;

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<{ status: number, ok: boolean, body: unknown }>}
   */
  async function call(method, path, body) {
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Key ${key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new RipeError(`${label}: ${method} ${path} got no answer from RIPE Atlas (${/** @type {Error} */ (err).name})`, 0);
    }
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: res.status, ok: res.ok, body: parsed };
  }

  return {
    label,

    /** The account's current balance. Needs "Get information about your credits". */
    async balance() {
      const r = await call('GET', '/credits/');
      if (!r.ok) throw new RipeError(`${label}: reading the balance: HTTP ${r.status}${detail(r.body)}`, r.status);
      const b = /** @type {{ current_balance?: unknown } | null} */ (r.body)?.current_balance;
      if (typeof b !== 'number' || !Number.isFinite(b)) throw new RipeError(`${label}: GET /credits/ returned no current_balance`, r.status);
      return b;
    },

    /**
     * Whether the key may read the account's credits: GET /credits/ answers 200 with it and 401
     * or 403 without. Anything else is RIPE failing, and throws.
     */
    async canRead() {
      const r = await call('GET', '/credits/');
      if (r.ok) return true;
      if (r.status === 401 || r.status === 403) return false;
      throw new RipeError(`${label}: GET /credits/: HTTP ${r.status}${detail(r.body)}`, r.status);
    },

    /**
     * Whether the key may transfer credits. RIPE has no endpoint a transfer key can use to list its
     * own permissions, so this posts a transfer with no recipient and no amount: RIPE checks the
     * key's permission first (403 without it) and then refuses the empty request (400). Nothing can
     * move, since the request names no amount and no one to send it to.
     */
    async canTransfer() {
      const r = await call('POST', '/credits/transfers/', {});
      if (r.status === 400) return true;
      if (r.status === 401 || r.status === 403) return false;
      throw new RipeError(`${label}: an empty transfer request got HTTP ${r.status}${detail(r.body)}, not the 400 or 403 expected`, r.status);
    },

    /**
     * The account's transfers (RIPE's `admin` transactions) recorded at or after `sinceMs`, newest
     * first, at most the latest 100. RIPE stamps them in whole seconds and lists a transfer 40 to
     * 70 seconds after it moved the credits (api/src/lib/atlas.ts, findTransferTransaction), so a
     * caller waits first.
     * @param {number} sinceMs
     * @returns {Promise<{ amount: number, date: number }[]>} date in milliseconds
     */
    async transfersSince(sinceMs) {
      const r = await call('GET', '/credits/transactions/?type=admin&sort=-date&page_size=100');
      if (!r.ok) throw new RipeError(`${label}: reading the transactions: HTTP ${r.status}${detail(r.body)}`, r.status);
      const rows = Array.isArray(r.body) ? r.body : (/** @type {{ results?: unknown[] } | null} */ (r.body)?.results ?? []);
      const earliest = Math.floor(sinceMs / 1000) * 1000;
      return rows
        .map((row) => {
          const { amount, date } = /** @type {{ amount?: unknown, date?: unknown }} */ (row);
          const when = typeof date === 'number' ? date * 1000 : typeof date === 'string' ? Date.parse(date) : NaN;
          return { amount: Number(amount), date: when };
        })
        .filter((row) => Number.isFinite(row.amount) && Number.isFinite(row.date) && row.date >= earliest);
    },

    /**
     * Sends `amount` credits to the RIPE NCC Access account `recipient`. One POST, never retried:
     * a retry could send the credits twice. Throws a RipeError with status 0 or 5xx when the
     * outcome is unknown, and with a 4xx when RIPE refused (nothing moved).
     * @param {string} recipient
     * @param {number} amount
     */
    async transfer(recipient, amount) {
      const r = await call('POST', '/credits/transfers/', { recipient, amount });
      if (r.ok) return;
      throw new RipeError(`${label}: transferring ${amount} credits: HTTP ${r.status}${detail(r.body)}`, r.status);
    },
  };
}

/** @typedef {ReturnType<typeof ripeClient>} RipeClient */

/**
 * Polls `read` until `done` holds for its value or the time runs out, and returns the last value
 * read either way. RIPE moves credits at once, but a balance read can still lag a moment.
 * @template T
 * @param {() => Promise<T>} read
 * @param {(value: T) => boolean} done
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function pollUntil(read, done, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3_000));
    value = await read();
  }
  return value;
}

/**
 * Which of the two keys pays in the insufficient-credits test: the one with the smaller balance,
 * so the amount asked for (its balance plus one) is as small as possible. The recipient key on a
 * tie: it normally holds nothing between runs.
 * @param {{ donor: number, recipient: number }} balances
 * @returns {'donor' | 'recipient'}
 */
export function shortSide(balances) {
  return balances.donor < balances.recipient ? 'donor' : 'recipient';
}
