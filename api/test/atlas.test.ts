import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKeyFormat, AtlasRefused, AtlasUnreachable, describeAtlasError, findTransferTransaction, getCredits, transferCredits } from '../src/lib/atlas';
import { HttpError } from '../src/lib/http';

const KEY = '12345678-1234-1234-1234-123456789abc';

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

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

// The pledge handler decides whether to roll a reservation back or park it for a human by
// asking one question of a failed transfer: did RIPE answer? These tests pin that answer.

test('a refusal from RIPE is not AtlasUnreachable, because no credits moved', async () => {
  const err = await withFetch(
    async () => new Response(JSON.stringify({ error: { status: 400, detail: 'Not enough credits.' } }), { status: 400 }),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.ok(err instanceof HttpError);
  assert.equal(err instanceof AtlasUnreachable, false);
  assert.equal(err.status, 400);
});

test('rate limiting is a refusal too, and keeps its 429', async () => {
  const err = await withFetch(
    async () => new Response('{}', { status: 429 }),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.equal(err instanceof AtlasUnreachable, false);
  assert.equal((err as HttpError).status, 429);
});

test('a network failure is AtlasUnreachable, because the outcome is unknown', async () => {
  const err = await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.ok(err instanceof AtlasUnreachable);
  assert.equal(err.status, 502);
});

test('a timeout is AtlasUnreachable: RIPE may still have taken the credits', async () => {
  const err = await withFetch(
    async () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    },
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.ok(err instanceof AtlasUnreachable);
  assert.match(err.message, /did not respond in time/);
});

test('a transfer posts exactly once, whatever the response', async () => {
  const paths: string[] = [];
  await withFetch(
    async (input) => {
      paths.push(String(input));
      return new Response('{}', { status: 404 });
    },
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, () => null),
  );
  assert.equal(paths.length, 1, 'a second POST could send the credits twice');
  assert.match(paths[0], /\/credits\/transfers\/$/);
});

test('a 2xx without a transaction field still counts as sent', async () => {
  const res = await withFetch(
    async () => new Response(JSON.stringify({ amount: 10, recipient: 'someone@example.org' }), { status: 201 }),
    () => transferCredits(KEY, 'someone@example.org', 10),
  );
  assert.deepEqual(res, { transaction: '' });
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

test('a connection that dies mid-body is AtlasUnreachable, not a refusal', async () => {
  // The status line arrived, so the request definitely reached RIPE, but the body never finished.
  // Treating that as a refusal would roll the pledge back and invite a retry that sends twice.
  const err = await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 201 },
      ),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.ok(err instanceof AtlasUnreachable, `expected AtlasUnreachable, got ${err?.constructor?.name}`);
  assert.equal(err.status, 502);
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

test('a truncated refusal is still a refusal, not an unknown outcome', async () => {
  // RIPE answered with a 4xx and the body was lost. The status is a complete answer on its own:
  // nothing moved. Parking this as uncertain would strand a pledge that should simply be cancelled.
  const err = await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 400 },
      ),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.equal(err instanceof AtlasUnreachable, false, 'a refusal must not read as unknown');
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
});

test('a 5xx on a transfer is an unknown outcome, not a refusal', async () => {
  // RIPE broke somewhere internally. That says nothing about whether it processed the transfer
  // first, so rolling the pledge back and letting the donor retry could send the credits twice.
  const err = await withFetch(
    async () => new Response('{}', { status: 503 }),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.ok(err instanceof AtlasUnreachable);
  assert.equal(err.status, 502);
});

test('a 4xx on a transfer is still a refusal, so the donor can retry', async () => {
  const err = await withFetch(
    async () => new Response(JSON.stringify({ error: { detail: 'Not enough credits.' } }), { status: 400 }),
    () => transferCredits(KEY, 'someone@example.org', 10).then(() => null, (e) => e),
  );
  assert.equal(err instanceof AtlasUnreachable, false);
  assert.equal(err.status, 400);
});
