// Storage tokens for e2e-real/lock-holder.mjs, which renews the lock for up to two hours: longer
// than one access token lasts, so it asks for a new one before the old one runs out.
//
// - On the owner's machine: from the Azure CLI (az account get-access-token), which refreshes its
//   own sign-in.
// - In GitHub Actions: az cannot renew there. azure/login signs it in with a GitHub OIDC token
//   that is valid for minutes, and az holds no refresh token, so once its access token for a
//   resource expires (about an hour) it has nothing left to sign in with. This asks GitHub for a
//   fresh OIDC token each time and trades it at Microsoft Entra ID for a storage token, as
//   the CI identity's federated credential allows.
import { execFile } from 'node:child_process';

/** Ask for a new token when the current one has less than this left. */
const MARGIN_MS = 10 * 60_000;

/**
 * @typedef {{ token: string, expiresAt: number }} Token
 * @typedef {() => Promise<Token>} TokenFetcher
 */

/**
 * @param {TokenFetcher} fetcher
 * @param {{ now?: () => number, marginMs?: number }} [opts]
 * @returns {() => Promise<string>} a function that returns a token valid for at least marginMs
 */
export function cachedToken(fetcher, opts = {}) {
  const { now = Date.now, marginMs = MARGIN_MS } = opts;
  /** @type {Token | null} */
  let current = null;
  return async () => {
    if (!current || current.expiresAt - now() < marginMs) current = await fetcher();
    return current.token;
  };
}

/**
 * @param {string} resource e.g. https://storage.azure.com/
 * @param {{ run?: (args: string[]) => Promise<string> }} [opts]
 * @returns {TokenFetcher}
 */
export function azCliToken(resource, opts = {}) {
  const run =
    opts.run ??
    ((args) =>
      new Promise((resolve, reject) =>
        execFile('az', args, { timeout: 60_000 }, (err, stdout) => (err ? reject(new Error(`az account get-access-token failed: ${err.message.split('\n')[0]}`)) : resolve(stdout))),
      ));
  return async () => {
    const body = JSON.parse(await run(['account', 'get-access-token', '--resource', resource, '-o', 'json']));
    // expires_on (seconds) in recent versions, expiresOn (local time) in older ones.
    const expiresAt = body.expires_on ? Number(body.expires_on) * 1000 : Date.parse(body.expiresOn);
    if (!body.accessToken || !Number.isFinite(expiresAt)) throw new Error('az account get-access-token returned no token');
    return { token: body.accessToken, expiresAt };
  };
}

/**
 * @param {string} resource e.g. https://storage.azure.com/
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: () => number }} [opts]
 * @returns {TokenFetcher | null} null outside a GitHub Actions job that may request OIDC tokens
 */
export function githubFederatedToken(resource, opts = {}) {
  const { env = process.env, fetchImpl = fetch, now = Date.now } = opts;
  const { ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken, AZURE_CLIENT_ID: clientId, AZURE_TENANT_ID: tenantId } = env;
  if (!requestUrl || !requestToken || !clientId || !tenantId) return null;
  return async () => {
    const idUrl = new URL(requestUrl);
    idUrl.searchParams.set('audience', 'api://AzureADTokenExchange');
    const idRes = await fetchImpl(idUrl, { headers: { Authorization: `Bearer ${requestToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!idRes.ok) throw new Error(`GitHub OIDC token: HTTP ${idRes.status}`);
    const assertion = /** @type {{ value?: string }} */ (await idRes.json()).value;
    if (!assertion) throw new Error('GitHub OIDC token: no token in the response');
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      scope: `${resource.replace(/\/$/, '')}/.default`,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Microsoft Entra token for ${resource}: HTTP ${res.status}`);
    const body = /** @type {{ access_token?: string, expires_in?: number }} */ (await res.json());
    if (!body.access_token) throw new Error(`Microsoft Entra token for ${resource}: no token in the response`);
    return { token: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
  };
}
