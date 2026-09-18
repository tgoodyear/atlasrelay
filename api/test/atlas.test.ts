import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKeyFormat, AtlasRefused, describeAtlasError, findTransferTransaction, getCredits, transferCredits } from '../src/lib/atlas';
import { HttpError } from '../src/lib/http';

test('assertKeyFormat only accepts UUIDs', () => {
  assert.equal(assertKeyFormat(' 12345678-1234-1234-1234-123456789abc '), '12345678-1234-1234-1234-123456789abc');
  assert.throws(() => assertKeyFormat('not-a-key'), HttpError);
  assert.throws(() => assertKeyFormat(undefined), HttpError);
});

test('describeAtlasError surfaces RIPE detail and field errors', () => {
  const msg = describeAtlasError(400, {
    error: { status: 400, detail: 'The following fields are invalid: recipient', errors: [{ source: { pointer: '/recipient' }, detail: 'Unknown user.' }] },
  });
  assert.equal(msg, 'The following fields are invalid: recipient recipient: Unknown user.');
});

test('describeAtlasError has sane fallbacks', () => {
  assert.match(describeAtlasError(403, null), /rejected the API key/);
  assert.match(describeAtlasError(429, {}), /rate-limiting/);
  assert.match(describeAtlasError(500, ''), /HTTP 500/);
});

test('an ambiguous transaction match records no reference at all', async () => {
  // Two outgoing rows of the same size inside the window: there is no way to tell which is ours,
  // and a reference pointing at the wrong transfer is worse than none.
  const real = globalThis.fetch;
  const rows = [
    { id: 11, type: 'admin', amount: -500, date: '2026-09-17T12:00:05Z' },
    { id: 12, type: 'admin', amount: -500, date: '2026-09-17T12:00:03Z' },
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: rows }), { status: 200 })) as typeof fetch;
  try {
    const since = Date.parse('2026-09-17T12:00:00Z');
    assert.equal(await findTransferTransaction('12345678-1234-1234-1234-123456789abc', 500, since), null);
    // One match is unambiguous and is recorded.
    globalThis.fetch = (async () => new Response(JSON.stringify({ results: [rows[0]] }), { status: 200 })) as typeof fetch;
    const one = await findTransferTransaction('12345678-1234-1234-1234-123456789abc', 500, since);
    assert.equal(one?.id, 11);
  } finally {
    globalThis.fetch = real;
  }
});

test('a refusal carries RIPE own status so a key problem is not confused with an outage', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch;
  try {
    const err = await getCredits('12345678-1234-1234-1234-123456789abc').then(() => null, (e) => e);
    assert.ok(err instanceof AtlasRefused);
    assert.equal(err.upstreamStatus, 403);
    assert.equal(err.status, 400, 'our own status stays flattened');
  } finally {
    globalThis.fetch = real;
  }
});

test('a transfer posts exactly once, whatever the response', async () => {
  // A retry against a second path could send the credits twice, and would also make a key's use
  // four outbound requests rather than the three SECURITY.md discloses.
  const real = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    paths.push(String(input));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    await transferCredits('12345678-1234-1234-1234-123456789abc', 'someone@example.org', 10).catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(paths.length, 1);
  assert.match(paths[0], /\/credits\/transfers\/$/);
});
