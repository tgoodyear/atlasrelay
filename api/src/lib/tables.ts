import { TableClient, type TableServiceClientOptions } from '@azure/data-tables';
import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';

/**
 * How the API reaches Table Storage, from its settings.
 *
 * In Azure the Function App has TABLES_ENDPOINT (https://<account>.table.core.windows.net/) and
 * AZURE_CLIENT_ID, the client id of its user-assigned managed identity, and signs in with that
 * identity. The storage account refuses shared keys, so there is no key to configure.
 *
 * TABLES_CONNECTION_STRING is for local development and tests against Azurite
 * (api/local.settings.json.example). When both are set it wins, so a developer can point a local
 * host at Azurite without unsetting anything. Nothing in Azure sets it.
 */
export type TableAccess =
  | { kind: 'connection-string'; connectionString: string; allowInsecureConnection: boolean }
  | { kind: 'endpoint'; endpoint: string; managedIdentityClientId: string };

export function tableAccess(env: Record<string, string | undefined>): TableAccess | null {
  const conn = env.TABLES_CONNECTION_STRING?.trim();
  if (conn) {
    return {
      kind: 'connection-string',
      connectionString: conn,
      allowInsecureConnection: conn.includes('127.0.0.1') || conn.includes('UseDevelopmentStorage'),
    };
  }
  const endpoint = env.TABLES_ENDPOINT?.trim();
  if (endpoint) {
    return { kind: 'endpoint', endpoint, managedIdentityClientId: env.AZURE_CLIENT_ID?.trim() ?? '' };
  }
  return null;
}

let credential: TokenCredential | null = null;

/**
 * One credential for every table, so a token is fetched once and cached rather than once per
 * table. The managed identity only: nothing else is tried, so a misconfigured app fails on its
 * first storage call instead of signing in as something else.
 */
function sharedCredential(clientId: string): TokenCredential {
  credential ??= clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
  return credential;
}

export function createTableClient(access: TableAccess, table: string, options: TableServiceClientOptions): TableClient {
  if (access.kind === 'connection-string') {
    return TableClient.fromConnectionString(access.connectionString, table, {
      ...options,
      allowInsecureConnection: access.allowInsecureConnection,
    });
  }
  return new TableClient(access.endpoint, table, sharedCredential(access.managedIdentityClientId), options);
}
