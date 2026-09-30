// The three Azure calls the test job makes, with its managed identity and plain fetch: a token
// from the Container Apps identity endpoint, a secret from Key Vault (through the private
// endpoint), and a blob upload to the results container.

/**
 * @param {string} resource e.g. https://vault.azure.net
 * @param {string | undefined} clientId the user-assigned identity to use
 */
export async function managedIdentityToken(resource, clientId) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) {
    throw new Error('No managed identity here (IDENTITY_ENDPOINT is unset). Outside the Container Apps job, set the E2E_* account variables instead.');
  }
  const url = new URL(endpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', resource);
  if (clientId) url.searchParams.set('client_id', clientId);
  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!res.ok) throw new Error(`Managed identity token for ${resource}: HTTP ${res.status}`);
  const body = /** @type {{ access_token?: string }} */ (await res.json());
  if (!body.access_token) throw new Error(`Managed identity token for ${resource}: no token in the response`);
  return body.access_token;
}

/** @param {Response} res */
async function errorCode(res) {
  try {
    const body = /** @type {{ error?: { code?: string } }} */ (await res.json());
    return body.error?.code ?? '';
  } catch {
    return '';
  }
}

/**
 * Reads one secret's value. The value is never logged; errors name the secret and the status only.
 * @param {string} vaultUri e.g. https://kv-atlasrelay-dev-abc.vault.azure.net/
 * @param {string} name
 * @param {string} token for https://vault.azure.net
 * @param {{ optional?: boolean }} [opts] optional: a missing secret reads as ''
 */
export async function getSecret(vaultUri, name, token, opts = {}) {
  const url = new URL(`secrets/${encodeURIComponent(name)}`, vaultUri);
  url.searchParams.set('api-version', '7.4');
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status < 500 || attempt === 3) break;
    } catch (err) {
      if (attempt === 3) throw new Error(`Key Vault secret ${name}: ${/** @type {Error} */ (err).message}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  if (!res) throw new Error(`Key Vault secret ${name}: no response`);
  if (res.status === 404 && opts.optional) return '';
  if (!res.ok) throw new Error(`Key Vault secret ${name}: HTTP ${res.status} ${await errorCode(res)}`.trim());
  const body = /** @type {{ value?: string }} */ (await res.json());
  return body.value ?? '';
}

/**
 * @param {string} containerUrl e.g. https://account.blob.core.windows.net/results
 * @param {string} path blob name inside the container
 * @param {Buffer} body
 * @param {string} contentType
 * @param {string} token for https://storage.azure.com/
 */
export async function putBlob(containerUrl, path, body, contentType, token) {
  const url = `${containerUrl.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-ms-version': '2023-11-03',
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': contentType,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`Upload ${path}: HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim());
}
