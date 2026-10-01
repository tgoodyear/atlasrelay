import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the RIPE Atlas endpoints the API calls (api/src/lib/atlas.ts): the balance read
// GET /credits/ and the transfer POST /credits/transfers/ with a donor's key, and the transaction
// read GET /credits/transactions/ with a project owner's key. The Functions host reaches it through
// ATLAS_API_BASE, so no test ever talks to atlas.ripe.net.
//
// Tests run in parallel against one stub, so behaviour is chosen per API key: a test registers a
// scenario for its own fake key, and reads back only the requests made with that key. Keys are
// fake by construction (see fakeKey in fixtures.ts).

export type Reply =
  /** Answer with this status and JSON body. */
  | { kind: 'json'; status: number; body?: unknown }
  /** Read the request and never answer, so the API's own deadline fires. */
  | { kind: 'hang' }
  /** Close the connection without a response. */
  | { kind: 'drop' }
  /** Read the request and answer with `reply` only once a test releases this key (POST /__stub/release). */
  | { kind: 'held'; reply: Reply };

export interface Scenario {
  balance?: Reply;
  transfer?: Reply;
  /** The key holder's transaction list. An empty list when not given. */
  transactions?: Reply;
}

export interface RecordedRequest {
  method: string;
  path: string;
  /** The key from `Authorization: Key <key>`, or '' when the header was missing or malformed. */
  key: string;
  body: unknown;
  at: string;
}

const API_PREFIX = '/api/v2';

/** What RIPE sends for a key it will not accept. Used when a test registered nothing for a key. */
const UNKNOWN_KEY: Reply = {
  kind: 'json',
  status: 403,
  body: { error: { status: 403, title: 'Forbidden', detail: 'The provided API key is not valid (e2e stub: no scenario registered).' } },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export interface RipeStub {
  url: string;
  close(): Promise<void>;
}

export async function startRipeStub(port: number): Promise<RipeStub> {
  const scenarios = new Map<string, Scenario>();
  const requests: RecordedRequest[] = [];
  const hanging = new Set<ServerResponse>();
  const held = new Map<string, { res: ServerResponse; reply: Reply }[]>();

  // A row dated '@now' takes the moment it is served, in epoch seconds, so a test can make an arrival
  // that is newer than whatever it did while the request was held.
  const stamp = (body: unknown): unknown => {
    const results = (body as { results?: unknown[] } | null)?.results;
    if (!Array.isArray(results)) return body;
    const now = Math.floor(Date.now() / 1000);
    return { ...(body as object), results: results.map((r) => ((r as { date?: unknown }).date === '@now' ? { ...(r as object), date: now } : r)) };
  };
  const reply = (res: ServerResponse, r: Reply, key = '') => {
    if (r.kind === 'held') {
      held.set(key, [...(held.get(key) ?? []), { res, reply: r.reply }]);
      hanging.add(res);
      res.on('close', () => hanging.delete(res));
      return;
    }
    if (r.kind === 'json') return sendJson(res, r.status, stamp(r.body));
    if (r.kind === 'drop') return res.socket?.destroy();
    hanging.add(res);
    res.on('close', () => hanging.delete(res));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const text = await readBody(req);

    // Control endpoints, used by the test fixtures.
    if (url.pathname === '/__stub/scenarios' && req.method === 'POST') {
      const { key, scenario } = parse(text) as { key: string; scenario: Scenario };
      scenarios.set(key, scenario);
      return sendJson(res, 204, undefined);
    }
    if (url.pathname === '/__stub/release' && req.method === 'POST') {
      const { key } = parse(text) as { key: string };
      const waiting = held.get(key) ?? [];
      held.delete(key);
      for (const w of waiting) {
        hanging.delete(w.res);
        reply(w.res, w.reply, key);
      }
      return sendJson(res, 200, { released: waiting.length });
    }
    if (url.pathname === '/__stub/requests' && req.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      return sendJson(res, 200, { requests: requests.filter((r) => r.key === key) });
    }
    if (url.pathname === '/__stub/health') return sendJson(res, 200, { ok: true });

    // The RIPE Atlas API.
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Key ') ? auth.slice(4).trim() : '';
    requests.push({ method: req.method ?? '', path: url.pathname + url.search, key, body: parse(text), at: new Date().toISOString() });
    const scenario = scenarios.get(key);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;

    if (path === '/credits/' && req.method === 'GET') {
      return reply(res, scenario ? (scenario.balance ?? balanceOk(1_000_000)) : UNKNOWN_KEY);
    }
    if (path === '/credits/transfers/' && req.method === 'POST') {
      return reply(res, scenario ? (scenario.transfer ?? transferCreated()) : UNKNOWN_KEY);
    }
    if (path === '/credits/transactions/' && req.method === 'GET') {
      return reply(res, scenario ? (scenario.transactions ?? transactionsOk([])) : UNKNOWN_KEY, key);
    }
    return sendJson(res, 404, { error: { status: 404, title: 'Not Found', detail: `e2e stub has no route for ${req.method} ${url.pathname}` } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const res of hanging) res.socket?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Replies shaped like the live API's. The balance body matches CreditsOverview in atlas.ts; the
// transfer body carries the generic list URL RIPE returns for every transfer.

export function balanceOk(balance: number): Reply {
  return {
    kind: 'json',
    status: 200,
    body: { current_balance: balance, estimated_daily_income: 21_600, estimated_daily_expenditure: 0, estimated_runout_seconds: null, past_day_credits_spent: 0 },
  };
}

/** A transfer-only key: RIPE refuses the balance read. */
export function balanceRefused(): Reply {
  return {
    kind: 'json',
    status: 403,
    body: { error: { status: 403, title: 'Forbidden', detail: 'You do not have permission to perform this action.' } },
  };
}

export function transferCreated(): Reply {
  return {
    kind: 'json',
    status: 201,
    body: { transaction: 'https://atlas.ripe.net/api/v2/credits/transactions/?sort=-date&type=admin' },
  };
}

export function transferForbidden(): Reply {
  return {
    kind: 'json',
    status: 403,
    body: { error: { status: 403, title: 'Forbidden', detail: 'You do not have permission to perform this action.' } },
  };
}

/** A 400 with a field error, in the shape describeAtlasError reads. */
export function transferBadRequest(detail: string): Reply {
  return {
    kind: 'json',
    status: 400,
    body: { error: { status: 400, title: 'Bad Request', errors: [{ source: { pointer: '/recipient' }, detail }] } },
  };
}

/** One row of RIPE's transaction list, in the live shape: `date` in epoch seconds, amount signed. */
export interface TransactionRow {
  id: number;
  type: 'admin' | 'measurement' | 'probe';
  amount: number;
  /** Epoch seconds, or '@now' for the moment the stub serves it. */
  date: number | '@now';
  reason?: string;
  description?: string;
}

/** An admin row, dated `secondsFromNow` from the moment it is built. A positive amount arrived. */
export function adminRow(id: number, amount: number, secondsFromNow = 0, description = ''): TransactionRow {
  return { id, type: 'admin', amount, date: Math.floor(Date.now() / 1000) + secondsFromNow, reason: 'Transfer', description };
}

/** The paginated list the live API returns, newest first. */
export function transactionsOk(rows: TransactionRow[], next: string | null = null): Reply {
  const sorted = [...rows].sort((a, b) => (b.date === '@now' ? Infinity : b.date) - (a.date === '@now' ? Infinity : a.date));
  return { kind: 'json', status: 200, body: { count: sorted.length, next, previous: null, results: sorted } };
}

/** A key without "Get information about your credits": RIPE refuses the read. */
export function transactionsRefused(): Reply {
  return {
    kind: 'json',
    status: 403,
    body: { error: { status: 403, title: 'Forbidden', detail: 'You do not have permission to perform this action.' } },
  };
}
