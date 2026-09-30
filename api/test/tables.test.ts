import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTableClient, tableAccess } from '../src/lib/tables';

test('no storage settings means storage is not configured', () => {
  assert.equal(tableAccess({}), null);
  assert.equal(tableAccess({ TABLES_CONNECTION_STRING: ' ', TABLES_ENDPOINT: '' }), null);
});

test('in Azure the endpoint and the managed identity are used', () => {
  assert.deepEqual(
    tableAccess({ TABLES_ENDPOINT: 'https://example.table.core.windows.net/', AZURE_CLIENT_ID: 'client-id' }),
    { kind: 'endpoint', endpoint: 'https://example.table.core.windows.net/', managedIdentityClientId: 'client-id' },
  );
});

test('a connection string wins, so a local host can point at Azurite', () => {
  const access = tableAccess({
    TABLES_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    TABLES_ENDPOINT: 'https://example.table.core.windows.net/',
  });
  assert.deepEqual(access, {
    kind: 'connection-string',
    connectionString: 'UseDevelopmentStorage=true',
    allowInsecureConnection: true,
  });
});

test('only a local emulator is reached over plain http', () => {
  const remote = tableAccess({ TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=a2V5;EndpointSuffix=core.windows.net' });
  assert.equal(remote?.kind === 'connection-string' && remote.allowInsecureConnection, false);
  const azurite = tableAccess({ TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;' });
  assert.equal(azurite?.kind === 'connection-string' && azurite.allowInsecureConnection, true);
});

test('an endpoint client names the table and carries no key', () => {
  const client = createTableClient(
    { kind: 'endpoint', endpoint: 'https://example.table.core.windows.net/', managedIdentityClientId: 'client-id' },
    'projects',
    {},
  );
  assert.equal(client.tableName, 'projects');
  assert.equal(client.url, 'https://example.table.core.windows.net/');
});
