import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the two RIPE Atlas endpoints the API calls (api/src/lib/atlas.ts): the balance read
// GET /credits/ and the transfer POST /credits/transfers/. The Functions host reaches it through
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
  | { kind: 'drop' };

export interface Scenario {
  balance?: Reply;
  transfer?: Reply;
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

  const reply = (res: ServerResponse, r: Reply) => {
    if (r.kind === 'json') return sendJson(res, r.status, r.body);
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
