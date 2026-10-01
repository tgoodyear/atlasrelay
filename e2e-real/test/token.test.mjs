import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azCliToken, cachedToken, githubFederatedToken } from '../lib/token.mjs';

test('a cached token is reused, renewed in the background near its end, and awaited only at the last', async () => {
  let clock = 0;
  let fetched = 0;
  const get = cachedToken(async () => ({ token: `t${++fetched}`, expiresAt: clock + 60 * 60_000 }), { now: () => clock, marginMs: 10 * 60_000, minMs: 2 * 60_000 });
  assert.equal(await get(), 't1');
  clock = 49 * 60_000;
  assert.equal(await get(), 't1');
  assert.equal(fetched, 1);
  // Inside the margin: the old token now, the new one fetched alongside.
  clock = 51 * 60_000;
  assert.equal(await get(), 't1');
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched, 2);
  assert.equal(await get(), 't2');
  // Nearly expired: wait for a new one.
  clock = 51 * 60_000 + 59 * 60_000;
  assert.equal(await get(), 't3');
});

test('one fetch at a time', async () => {
  let fetched = 0;
  /** @type {(t: { token: string, expiresAt: number }) => void} */
  let finish = () => {};
  const get = cachedToken(() => {
    fetched++;
    return new Promise((r) => (finish = r));
  });
  const a = get();
  const b = get();
  finish({ token: 'x', expiresAt: Date.now() + 3_600_000 });
  assert.deepEqual(await Promise.all([a, b]), ['x', 'x']);
  assert.equal(fetched, 1);
});

test('the Azure CLI token is read with its expiry, in either format', async () => {
  /** @type {string[][]} */
  const seen = [];
  const fromSeconds = azCliToken('https://storage.azure.com/', {
    run: async (args) => {
      seen.push(args);
      return JSON.stringify({ accessToken: 'a', expires_on: 1_800_000_000 });
    },
  });
  assert.deepEqual(await fromSeconds(), { token: 'a', expiresAt: 1_800_000_000_000 });
  assert.deepEqual(seen[0], ['account', 'get-access-token', '--resource', 'https://storage.azure.com/', '-o', 'json']);
  const inSub = azCliToken('https://storage.azure.com/', {
    subscription: 'sub',
    run: async (args) => {
      seen.push(args);
      return JSON.stringify({ accessToken: 'c', expires_on: 1 });
    },
  });
  await inSub();
  assert.deepEqual(seen[1].slice(4, 6), ['--subscription', 'sub']);
  const fromDate = azCliToken('https://storage.azure.com/', { run: async () => JSON.stringify({ accessToken: 'b', expiresOn: '2026-10-01 12:00:00.000000' }) });
  assert.equal((await fromDate()).token, 'b');
  const empty = azCliToken('https://storage.azure.com/', { run: async () => '{}' });
  await assert.rejects(empty(), /returned no token/);
});

const GITHUB_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/id?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  AZURE_CLIENT_ID: 'client',
  AZURE_TENANT_ID: 'tenant',
};

test('outside a GitHub job that may ask for OIDC tokens there is no federated token', () => {
  assert.equal(githubFederatedToken('https://storage.azure.com/', { env: {} }), null);
  assert.equal(githubFederatedToken('https://storage.azure.com/', { env: { ...GITHUB_ENV, AZURE_TENANT_ID: '' } }), null);
});

test('in a GitHub job, a fresh OIDC token is traded for a storage token each time', async () => {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://token.actions.test/')) return Response.json({ value: `oidc${calls.length}` });
    return Response.json({ access_token: 'storage', expires_in: 3599 });
  };
  const fetcher = githubFederatedToken('https://storage.azure.com/', { env: GITHUB_ENV, fetchImpl, now: () => 1000 });
  assert.ok(fetcher);
  assert.deepEqual(await fetcher(), { token: 'storage', expiresAt: 1000 + 3_599_000 });
  await fetcher();
  assert.equal(calls.length, 4);
  const id = new URL(calls[0].url);
  assert.equal(id.searchParams.get('api-version'), '2.0');
  assert.equal(id.searchParams.get('audience'), 'api://AzureADTokenExchange');
  assert.equal(/** @type {Record<string, string>} */ (calls[0].init.headers).Authorization, 'Bearer request-token');
  assert.equal(calls[1].url, 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
  const form = new URLSearchParams(String(calls[1].init.body));
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'client');
  assert.equal(form.get('scope'), 'https://storage.azure.com/.default');
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(form.get('client_assertion'), 'oidc1');
  assert.equal(new URLSearchParams(String(calls[3].init.body)).get('client_assertion'), 'oidc3');
});

test('a refused trade is an error that names the status, not the token', async () => {
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => (String(url).startsWith('https://token.actions.test/') ? Response.json({ value: 'oidc-secret' }) : new Response('{}', { status: 401 }));
  const fetcher = githubFederatedToken('https://storage.azure.com/', { env: GITHUB_ENV, fetchImpl });
  await assert.rejects(/** @type {NonNullable<typeof fetcher>} */ (fetcher)(), (err) => {
    assert.match(/** @type {Error} */ (err).message, /HTTP 401/);
    assert.doesNotMatch(/** @type {Error} */ (err).message, /oidc-secret/);
    return true;
  });
});
