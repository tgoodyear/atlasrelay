import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api';

// Static Web Apps drops the Content-Type of a request with no body, and the API refuses a write
// without application/json (415). So every write the site sends carries a JSON body.

test('every write carries a JSON body and Content-Type, including DELETE /api/me', async () => {
  const seen: { method: string; body: unknown; contentType: string | undefined }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_path: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ method: init.method ?? 'GET', body: init.body, contentType: headers['content-type'] });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await api.deleteMe();
    await api.me();
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(seen[0], { method: 'DELETE', body: '{}', contentType: 'application/json' });
  assert.equal(seen[1].body, undefined, 'a GET has no body');
});
