import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasRefused, AtlasUnreachable, readAdminTransactions, type TransactionPage } from '../src/lib/atlas';
import { HttpError } from '../src/lib/http';
import { checkReceipt, incomingReceipts, matchReceipt, MAX_RECEIPTS_SHOWN, pageComplete, type CheckInput, type Receipt, type VerificationDetails } from '../src/lib/receipts';
import { creditedAmount, toPledge, totals, type Pledge } from '../src/lib/store';
import { privatePledge, publicPledge } from '../src/lib/views';
import { invocationLog, type LogSink } from '../src/lib/telemetry';

// A project owner confirming a manual pledge may paste a key of their own so the API reads what
// actually arrived. These tests pin the matching rules, what each failure says, the ceiling, and
// that the key goes nowhere but the one request to RIPE.

const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// The pledge was created at 2026-09-30T12:00:00.500Z; RIPE stamps whole seconds.
const CREATED = Date.parse('2026-09-30T12:00:00.500Z');
const SEC = Math.floor(CREATED / 1000);

function row(id: number, amount: number, secondsAfter: number, extra: Record<string, unknown> = {}) {
  return { id, type: 'admin', amount, date: SEC + secondsAfter, ...extra };
}

function page(rows: unknown[], hasMore = false): TransactionPage {
  return { rows: rows as TransactionPage['rows'], hasMore };
}

function input(rows: unknown[], over: Partial<CheckInput> = {}): CheckInput {
  return { key: KEY, pledged: 700, since: CREATED, used: new Set(), room: 1_000_000, read: async () => page(rows), ...over };
}

async function refusal(p: Promise<unknown>): Promise<HttpError & { details: { verification: VerificationDetails } }> {
  const err = await p.then(() => null, (e) => e);
  assert.ok(err instanceof HttpError, `expected an HttpError, got ${err}`);
  return err as HttpError & { details: { verification: VerificationDetails } };
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function capture(): { sink: LogSink; text: () => string } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { sink: { info: push, warn: push, error: push }, text: () => lines.join('\n') };
}

// ---------- which rows count ----------

test('only incoming admin rows from after the pledge count, newest first', () => {
  const got = incomingReceipts([
    row(1, 700, 30),
    row(2, -700, 40), // a transfer out of the owner's account
    { ...row(3, 700, 50), type: 'measurement' },
    row(4, 0, 60),
    row(5, 700.5, 70),
    row(6, 700, -1), // the second before the pledge
    row(7, 300, 90),
  ], CREATED, new Set());
  assert.deepEqual(got.map((r) => r.id), ['7', '1']);
  assert.equal(got[1].amount, 700);
  assert.equal(got[1].at, new Date((SEC + 30) * 1000).toISOString());
});

test('a row stamped in the same second as the pledge counts, one a second earlier does not', () => {
  // The pledge was written at .500 of its second and RIPE rounds down, so a transfer made right
  // after it can carry the same whole-second stamp.
  const got = incomingReceipts([row(1, 700, 0), row(2, 700, -1)], CREATED, new Set());
  assert.deepEqual(got.map((r) => r.id), ['1']);
});

test('rows with no usable id or date, or already matched elsewhere, are left out', () => {
  const got = incomingReceipts([
    { type: 'admin', amount: 700, date: SEC + 5 },
    { id: -3, type: 'admin', amount: 700, date: SEC + 5 },
    row(8, 700, 5, { date: 'not a date' }),
    row(9, 700, 5, { date: 1e20 }),
    row(10, 700, 5),
    null,
    'junk',
    row(11, 700, 6, { date: new Date((SEC + 6) * 1000).toISOString() }),
  ], CREATED, new Set(['10']));
  assert.deepEqual(got.map((r) => r.id), ['11']);
});

test('an unreadable pledge creation time matches nothing rather than everything', () => {
  assert.deepEqual(incomingReceipts([row(1, 700, 5)], Number.NaN, new Set()), []);
});

test('the note is RIPE reason and description, deduplicated, collapsed and cut short', () => {
  const [r] = incomingReceipts([row(1, 700, 5, { reason: 'Transfer', description: '  Transfer\n from  someone ' })], CREATED, new Set());
  assert.equal(r.note, 'Transfer / Transfer from someone');
  const [long] = incomingReceipts([row(2, 700, 5, { description: 'x'.repeat(500) })], CREATED, new Set());
  assert.equal(long.note.length, 200);
});

// ---------- matching ----------

const r = (id: string, amount: number): Receipt => ({ id, amount, at: '2026-09-30T12:01:00.000Z', note: '' });

test('exactly one arrival of the pledged amount is the match', () => {
  assert.deepEqual(matchReceipt([r('1', 700)], 700, true), { kind: 'exact', receipt: r('1', 700) });
  // Other amounts beside it are other transfers as far as anything here can tell.
  assert.deepEqual(matchReceipt([r('2', 50), r('1', 700), r('3', 9)], 700, true), { kind: 'exact', receipt: r('1', 700) });
});

test('two arrivals of the pledged amount are never guessed between', () => {
  const m = matchReceipt([r('1', 700), r('2', 700)], 700, true);
  assert.equal(m.kind, 'several');
});

test('a single arrival of another amount is offered, not recorded', () => {
  assert.deepEqual(matchReceipt([r('1', 500)], 700, true), { kind: 'different', receipt: r('1', 500) });
});

test('several arrivals of other amounts are listed for the owner', () => {
  const m = matchReceipt([r('1', 500), r('2', 900)], 700, true);
  assert.deepEqual(m, { kind: 'several', receipts: [r('1', 500), r('2', 900)], more: false });
});

test('nothing arrived', () => {
  assert.deepEqual(matchReceipt([], 700, true), { kind: 'none' });
});

test('an incomplete list never produces an automatic match', () => {
  // A row the read never saw could be a second arrival of the same amount.
  const m = matchReceipt([r('1', 700)], 700, false);
  assert.deepEqual(m, { kind: 'several', receipts: [r('1', 700)], more: true });
});

test('a long list is cut short and says so', () => {
  const many = Array.from({ length: MAX_RECEIPTS_SHOWN + 5 }, (_, i) => r(String(i + 1), 10 + i));
  const m = matchReceipt(many, 700, true);
  assert.equal(m.kind, 'several');
  if (m.kind === 'several') {
    assert.equal(m.receipts.length, MAX_RECEIPTS_SHOWN);
    assert.equal(m.more, true);
  }
});

test('a page is complete unless RIPE has more and the oldest row seen is still in the window', () => {
  assert.equal(pageComplete(page([row(1, 1, 10)], false), CREATED), true);
  assert.equal(pageComplete(page([row(1, 1, 10), row(2, 1, -100)], true), CREATED), true);
  assert.equal(pageComplete(page([row(1, 1, 10), row(2, 1, 5)], true), CREATED), false);
  assert.equal(pageComplete(page([], true), CREATED), false);
});

// ---------- the check ----------

test('an exact arrival is recorded as verified, with its reference', async () => {
  const got = await checkReceipt(input([row(640025999, 700, 45)]));
  assert.deepEqual(got, { outcome: 'exact', amount: 700, verified: true, transactionId: '640025999' });
});

test('a different amount is shown to the owner first, and recorded once they choose it', async () => {
  const err = await refusal(checkReceipt(input([row(77, 500, 45)])));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'RIPE Atlas shows 500 credits arrived since this pledge was made (pledged 700).');
  assert.equal(err.details.verification.outcome, 'different');
  assert.equal(err.details.verification.pledged, 700);
  assert.deepEqual(err.details.verification.receipts?.map((x) => [x.id, x.amount]), [['77', 500]]);

  const got = await checkReceipt(input([row(77, 500, 45)], { choice: '77' }));
  assert.deepEqual(got, { outcome: 'chosen', amount: 500, verified: true, transactionId: '77' });
});

test('nothing yet: the owner is told it may not be indexed, and can confirm as pledged', async () => {
  const err = await refusal(checkReceipt(input([row(1, -700, 45)])));
  assert.equal(err.status, 409);
  assert.equal(err.details.verification.outcome, 'none');
  assert.match(err.message, /can take a minute or two to appear/);
  assert.match(err.message, /confirm the pledged 700 credits without checking/);
});

test('several candidates are listed, and the owner picks one', async () => {
  const rows = [row(1, 700, 45), row(2, 700, 50)];
  const err = await refusal(checkReceipt(input(rows)));
  assert.equal(err.details.verification.outcome, 'several');
  assert.deepEqual(err.details.verification.receipts?.map((x) => x.id), ['2', '1']);
  const got = await checkReceipt(input(rows, { choice: '1' }));
  assert.equal(got.transactionId, '1');
  assert.equal(got.verified, true);
});

test('a chosen row has to still qualify when it is read again', async () => {
  // Already recorded against another pledge since the list was shown.
  const used = await refusal(checkReceipt(input([row(1, 700, 45)], { choice: '1', used: new Set(['1']) })));
  assert.equal(used.details.verification.outcome, 'choice-unavailable');
  // An outgoing row, or one from before the pledge, cannot be chosen by sending its id.
  const out = await refusal(checkReceipt(input([row(2, -700, 45)], { choice: '2' })));
  assert.equal(out.details.verification.outcome, 'choice-unavailable');
  const early = await refusal(checkReceipt(input([row(3, 700, -60)], { choice: '3' })));
  assert.equal(early.details.verification.outcome, 'choice-unavailable');
});

test('an arrival already recorded against another pledge is not matched again', async () => {
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { used: new Set(['1']) })));
  assert.equal(err.details.verification.outcome, 'none');
});

// ---------- the ceiling ----------

test('an actual amount past the ceiling is explained, with the pledged amount offered when it fits', async () => {
  const err = await refusal(checkReceipt(input([row(1, 900, 45)], { pledged: 700, room: 800, choice: '1' })));
  assert.equal(err.status, 409);
  assert.equal(err.details.verification.outcome, 'over-ceiling');
  assert.equal(err.details.verification.room, 800);
  assert.match(err.message, /RIPE Atlas shows 900 credits arrived for this pledge \(pledged 700\)/);
  assert.match(err.message, /You can confirm the pledged 700 credits without the check, or cancel the pledge\./);
});

test('when neither amount fits, the owner is told to cancel, as before', async () => {
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { pledged: 700, room: 600 })));
  assert.equal(err.details.verification.outcome, 'over-ceiling');
  assert.match(err.message, /cancel it instead/);
  assert.doesNotMatch(err.message, /confirm the pledged/);
});

test('a smaller actual amount can be recorded even when the pledged one would not fit', async () => {
  const got = await checkReceipt(input([row(1, 400, 45)], { pledged: 700, room: 500, choice: '1' }));
  assert.deepEqual(got, { outcome: 'chosen', amount: 400, verified: true, transactionId: '1' });
});

test('exactly at the ceiling is allowed', async () => {
  const got = await checkReceipt(input([row(1, 700, 45)], { room: 700 }));
  assert.equal(got.amount, 700);
});

// ---------- failures ----------

test('a key without the read permission is refused clearly and nothing is confirmed', async () => {
  for (const status of [401, 403]) {
    const err = await refusal(checkReceipt(input([], { read: async () => { throw new AtlasRefused(status, 400, 'Forbidden'); } })));
    assert.equal(err.status, 400);
    assert.equal(err.details.verification.outcome, 'key-refused');
    assert.match(err.message, /Get information about your credits/);
    assert.match(err.message, /Nothing was recorded, and the key was not kept\./);
  }
});

test('other refusals keep their status and say nothing was recorded', async () => {
  const err = await refusal(checkReceipt(input([], { read: async () => { throw new AtlasRefused(429, 429, 'RIPE Atlas is rate-limiting requests.'); } })));
  assert.equal(err.status, 429);
  assert.equal(err.details.verification.outcome, 'refused');
  assert.match(err.message, /Nothing was recorded\.$/);
});

test('RIPE not answering confirms the pledged amount, unverified', async () => {
  const got = await checkReceipt(input([], { read: async () => { throw new AtlasUnreachable('Could not reach RIPE Atlas'); } }));
  assert.deepEqual(got, { outcome: 'unreachable', amount: 700, verified: false, transactionId: '' });
  // Still bounded by the ceiling.
  const err = await refusal(checkReceipt(input([], { room: 100, read: async () => { throw new AtlasUnreachable('x'); } })));
  assert.equal(err.status, 409);
  assert.match(err.message, /exceed the project's ceiling/);
});

test('an unexpected failure is not mistaken for RIPE being down', async () => {
  const err = await checkReceipt(input([], { read: async () => { throw new TypeError('boom'); } })).then(() => null, (e) => e);
  assert.ok(err instanceof TypeError);
});

// ---------- the request to RIPE ----------

test('the read is one GET of the admin transaction list, with the key in the header only', async () => {
  const seen: { url: string; method: string; auth: string | null }[] = [];
  const got = await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ count: 1, next: null, previous: null, results: [row(1, 700, 5)] }), { status: 200 });
    },
    () => readAdminTransactions(KEY),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, 'https://atlas.ripe.net/api/v2/credits/transactions/?sort=-date&type=admin&page_size=100');
  assert.equal(seen[0].url.includes(KEY), false);
  assert.equal(seen[0].auth, `Key ${KEY}`);
  assert.equal(got.rows.length, 1);
  assert.equal(got.hasMore, false);
});

test('the read reports a further page, refusals and outages', async () => {
  const more = await withFetch(async () => new Response(JSON.stringify({ next: 'https://atlas.ripe.net/api/v2/credits/transactions/?page=2', results: [] }), { status: 200 }), () => readAdminTransactions(KEY));
  assert.equal(more.hasMore, true);

  const forbidden = await withFetch(async () => new Response(JSON.stringify({ error: { status: 403, detail: 'You do not have permission to perform this action.' } }), { status: 403 }), () => readAdminTransactions(KEY).then(() => null, (e) => e));
  assert.ok(forbidden instanceof AtlasRefused);
  assert.equal(forbidden.upstreamStatus, 403);

  const down = await withFetch(async () => new Response('', { status: 503 }), () => readAdminTransactions(KEY).then(() => null, (e) => e));
  assert.ok(down instanceof AtlasUnreachable);

  const lost = await withFetch(async () => { throw new TypeError('fetch failed'); }, () => readAdminTransactions(KEY).then(() => null, (e) => e));
  assert.ok(lost instanceof AtlasUnreachable);

  // A 200 that is not a list is not "nothing arrived".
  const garbled = await withFetch(async () => new Response('<html>', { status: 200 }), () => readAdminTransactions(KEY).then(() => null, (e) => e));
  assert.ok(garbled instanceof AtlasUnreachable);
});

test('the owner key reaches no log line and no error, whatever RIPE does', async () => {
  const { sink, text } = capture();
  const replies: (() => Response | never)[] = [
    () => new Response(JSON.stringify({ results: [row(1, 700, 5)] }), { status: 200 }),
    () => new Response(JSON.stringify({ results: [row(1, 500, 5)] }), { status: 200 }),
    () => new Response(JSON.stringify({ error: { status: 403, detail: `bad key ${KEY}` } }), { status: 403 }),
    () => new Response('', { status: 500 }),
    () => { throw new TypeError(`fetch failed for Key ${KEY}`); },
  ];
  const errors: string[] = [];
  for (const reply of replies) {
    const result = await invocationLog.run(sink, () =>
      withFetch(async () => reply(), () => checkReceipt({ key: KEY, pledged: 700, since: CREATED, used: new Set(), room: 1_000_000 }).then((x) => x, (e) => e)),
    );
    if (result instanceof HttpError) errors.push(JSON.stringify({ message: result.message, details: result.details }));
  }
  const log = text();
  assert.match(log, /"name":"GET \/credits\/transactions\/"/);
  assert.equal(log.includes(KEY), false, log);
  assert.equal(/authorization/i.test(log), false, log);
  assert.equal(log.includes('page_size'), false, 'the query string is not logged');
  // RIPE's own refusal text is passed on to the owner, so a key it quoted would come back here.
  // This one does not quote the key RIPE was sent: describeAtlasError reads RIPE's detail, and our
  // message for a key refusal is fixed.
  for (const e of errors) assert.equal(e.includes(KEY), false, e);
});

// ---------- what gets counted and shown ----------

const base: Pledge = {
  id: 'p1', projectId: 'j1', donorId: 'd1', donorName: 'Ada', anonymous: false, amount: 700, method: 'manual',
  status: 'confirmed', transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false,
  inFlight: false, inFlightSince: '', receivedAmount: 0, amountVerified: false, message: '',
  createdAt: '2026-09-30T12:00:00.500Z', updatedAt: '2026-09-30T12:05:00.000Z',
};

test('totals count what arrived when it was checked, and the pledge otherwise', () => {
  const verified = { ...base, receivedAmount: 500, amountVerified: true, transactionId: '77' };
  assert.equal(creditedAmount(verified), 500);
  assert.equal(creditedAmount(base), 700);
  assert.deepEqual(totals([verified, { ...base, id: 'p2' }]), { confirmed: 1200, pending: 0 });
  // A pending pledge reserves what was pledged.
  assert.deepEqual(totals([{ ...base, status: 'sent' }]), { confirmed: 0, pending: 700 });
});

test('the public view shows the confirmed amount, the pledged one, and whether it was verified', () => {
  const verified = { ...base, receivedAmount: 500, amountVerified: true, transactionId: '77' };
  const pub = publicPledge(verified);
  assert.equal(pub.amount, 500);
  assert.equal(pub.pledgedAmount, 700);
  assert.equal(pub.amountVerified, true);
  assert.equal(pub.hasReference, true);
  assert.equal('transactionId' in pub, false, 'the reference itself is for the owner and the donor');
  assert.equal(privatePledge(verified).transactionId, '77');
});

test('a row written before these fields existed reads as it always did', () => {
  const old = toPledge({ partitionKey: 'j1', rowKey: 'p1', amount: 700, method: 'manual', status: 'confirmed', createdAt: base.createdAt });
  assert.equal(old.receivedAmount, 0);
  assert.equal(old.amountVerified, false);
  // Anything but a positive whole number in the column is treated as never read.
  for (const junk of ['abc', -5, 1.5, null, '']) assert.equal(toPledge({ partitionKey: 'j1', rowKey: 'p1', receivedAmount: junk }).receivedAmount, 0);
  assert.equal(toPledge({ partitionKey: 'j1', rowKey: 'p1', receivedAmount: 500, amountVerified: true }).receivedAmount, 500);
  const pub = publicPledge(old);
  assert.equal(pub.amount, 700);
  assert.equal(pub.pledgedAmount, 700);
  assert.equal(pub.amountVerified, false);
});
