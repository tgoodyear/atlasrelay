import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKeyFormat, AtlasRefused, transactionTime, describeAtlasError, findTransferTransaction, getCredits, transferCredits } from '../src/lib/atlas';
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

test('a transaction from before the transfer is never taken as its reference', async () => {
  // A same-sized transfer the donor made moments earlier is exactly the row a backwards-looking
  // window would latch onto, and recording it would attach the wrong proof to this pledge.
  const since = Date.parse('2026-09-18T12:00:00Z');
  const earlier = { id: 9, type: 'admin', amount: -500, date: '2026-09-18T11:57:00Z' };
  const res = await withFetch(
    async () => new Response(JSON.stringify({ results: [earlier] }), { status: 200 }),
    () => findTransferTransaction(KEY, 500, since),
  );
  assert.equal(res, null);

  // An unreadable timestamp is no evidence either, so it is rejected rather than accepted.
  const undated = await withFetch(
    async () => new Response(JSON.stringify({ results: [{ ...earlier, date: 'not a date' }] }), { status: 200 }),
    () => findTransferTransaction(KEY, 500, since),
  );
  assert.equal(undated, null);
});

// The fixtures below are real RIPE responses, captured from the live API on 2026-09-18 with a
// production key. They exist because every one of these shapes had been guessed at, and two of
// the guesses were wrong in ways no amount of reading the code could reveal.

test('a transaction date is epoch seconds, not an ISO string', () => {
  // Verified live: {"id":640025586,"type":"admin","amount":-500000,"date":1789680550}.
  // The code typed this as a string and handed it to Date.parse, which returns NaN for a number,
  // so the matcher discarded every candidate row and no transfer could ever be matched.
  assert.equal(transactionTime(1789680550), 1789680550_000);
  assert.equal(new Date(transactionTime(1789680550)!).toISOString(), '2026-09-17T21:29:10.000Z');
  assert.equal(Date.parse(1789680550 as unknown as string), Number.NaN);
  // A string epoch and a real ISO string both still work.
  assert.equal(transactionTime('1789680550'), 1789680550_000);
  assert.equal(transactionTime('2026-09-17T21:29:10.000Z'), 1789680550_000);
  assert.equal(transactionTime('not a date'), null);
});

test('the matcher finds a real transaction row, in the real response shape', async () => {
  // The live list is {count, next, previous, results:[...]}, newest first, dates in epoch seconds.
  const live = {
    count: 12,
    next: null,
    previous: null,
    results: [
      { id: 640025586, type: 'admin', amount: -500000, date: 1789680550, balance_after: 42820829 },
      { id: 634128531, type: 'admin', amount: -20000000, date: 1788535970 },
      { id: 565136927, type: 'admin', amount: 5764023, date: 1763978404 },
    ],
  };
  const since = 1789680550_000 - 60_000;
  const found = await withFetch(
    async () => new Response(JSON.stringify(live), { status: 200 }),
    () => findTransferTransaction(KEY, 500_000, since),
  );
  assert.equal(found?.id, 640025586);

  // An incoming credit of the same size must never be taken for an outgoing transfer.
  const incoming = await withFetch(
    async () => new Response(JSON.stringify({ results: [{ id: 1, type: 'admin', amount: 500000, date: 1789680550 }] }), { status: 200 }),
    () => findTransferTransaction(KEY, 500_000, since),
  );
  assert.equal(incoming, null);
});

test('a real RIPE refusal is described from the fields it actually sends', () => {
  // Captured live from POST /credits/transfers/ with an unroutable recipient. No credits moved.
  const body = {
    error: {
      detail: 'There was a problem with your request',
      status: 400,
      title: 'Bad Request',
      code: 102,
      errors: [{ source: { pointer: '/recipient' }, detail: 'That email address is not associated with any RIPE NCC Access user' }],
    },
  };
  const msg = describeAtlasError(400, body);
  assert.match(msg, /not associated with any RIPE NCC Access user/);
  assert.match(msg, /recipient/);
});
