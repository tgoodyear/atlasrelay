import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasRefused, AtlasUnreachable, readAdminTransactions, type TransactionPage } from '../src/lib/atlas';
import { HttpError } from '../src/lib/http';
import { checkReceipt, incomingReceipts, matchReceipt, MAX_RECEIPTS_SHOWN, pageComplete, type CheckInput, type Receipt, type VerificationDetails } from '../src/lib/receipts';
import { creditedAmount, RECEIPT_CLOCK_SKEW_MS, RECEIPT_INDEXING_SLACK_MS, receiptLedger, receiptReservationReclaimable, confirmLockStale, toPledge, totals, type Pledge } from '../src/lib/store';
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

const r = (id: string, amount: number, contested = false): Receipt => ({ id, amount, at: '2026-09-30T12:01:00.000Z', note: '', contested });

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
  assert.deepEqual(matchReceipt([], 700, true), { kind: 'none', more: false });
  assert.deepEqual(matchReceipt([], 700, false), { kind: 'none', more: true });
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
  assert.deepEqual(got, { outcome: 'exact', amount: 700, transactionId: '640025999' });
});

test('a different amount is shown to the owner first, and recorded once they choose it', async () => {
  const err = await refusal(checkReceipt(input([row(77, 500, 45)])));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'RIPE Atlas shows 500 credits arrived since this pledge was made (pledged 700).');
  assert.equal(err.details.verification.outcome, 'different');
  assert.equal(err.details.verification.pledged, 700);
  assert.deepEqual(err.details.verification.receipts?.map((x) => [x.id, x.amount]), [['77', 500]]);

  const got = await checkReceipt(input([row(77, 500, 45)], { choice: '77' }));
  assert.deepEqual(got, { outcome: 'chosen', amount: 500, transactionId: '77' });
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
});

test('an incomplete page with one candidate is offered, and does not claim there were several', async () => {
  const err = await refusal(checkReceipt(input([row(1, 700, 45), row(2, 5, 30)], { read: async () => page([row(1, 700, 45), row(2, 5, 30)], true) })));
  assert.equal(err.details.verification.outcome, 'several');
  assert.equal(err.details.verification.more, true);
  const one = await refusal(checkReceipt(input([], { read: async () => page([row(1, 700, 45), row(3, -5, 30)], true) })));
  assert.equal(one.details.verification.outcome, 'several');
  assert.deepEqual(one.details.verification.receipts?.map((x) => x.id), ['1']);
  assert.match(one.message, /cannot be picked out automatically/);
  assert.doesNotMatch(one.message, /more than one/);
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
  assert.match(err.message, /RIPE Atlas shows 900 credits arrived in the transfer matched to this pledge \(pledged 700\)/);
  assert.match(err.message, /You can confirm the pledged 700 credits without checking, or cancel the pledge\./);
});

test('when neither amount fits, the owner is told to cancel, as before', async () => {
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { pledged: 700, room: 600 })));
  assert.equal(err.details.verification.outcome, 'over-ceiling');
  assert.match(err.message, /cancel the pledge instead/);
  assert.doesNotMatch(err.message, /confirm the pledged/);
});

test('a smaller actual amount can be recorded even when the pledged one would not fit', async () => {
  const got = await checkReceipt(input([row(1, 400, 45)], { pledged: 700, room: 500, choice: '1' }));
  assert.deepEqual(got, { outcome: 'chosen', amount: 400, transactionId: '1' });
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

test('RIPE not answering records nothing, and offers the pledged amount without the check', async () => {
  const err = await refusal(checkReceipt(input([], { read: async () => { throw new AtlasUnreachable('Could not reach RIPE Atlas'); } })));
  assert.equal(err.status, 409);
  assert.equal(err.details.verification.outcome, 'unreachable');
  assert.equal(err.message, 'RIPE Atlas did not answer, so the amount could not be checked. Nothing was recorded. Check again, or confirm the pledged 700 credits without checking.');
});

test('a project already at its ceiling is refused before the key is sent anywhere', async () => {
  let reads = 0;
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { room: 0, read: async () => { reads += 1; return page([]); } })));
  assert.equal(err.status, 409);
  assert.match(err.message, /exceed the project's ceiling/);
  assert.equal(reads, 0);
});

test('a key quoted back in a RIPE refusal is removed from what the owner is sent', async () => {
  const err = await refusal(checkReceipt(input([], { read: async () => { throw new AtlasRefused(400, 400, `Bad key ${KEY} in request`); } })));
  assert.equal(err.message.includes(KEY), false);
  assert.match(err.message, /Bad key \[key\] in request/);
});

test('an unexpected failure is not mistaken for RIPE being down', async () => {
  const err = await checkReceipt(input([], { read: async () => { throw new TypeError('boom'); } })).then(() => null, (e) => e);
  assert.ok(err instanceof TypeError);
});

// ---------- other pledges that could own an arrival ----------

test('an arrival another pledge of the same amount could own is marked contested', () => {
  const from = CREATED - 60_000;
  const got = incomingReceipts([row(1, 700, 30), row(2, 500, 30), row(3, 700, 4000)], CREATED, new Set(), [
    // Confirmed without a reference: its transfer was listed no later than shortly after it was last written.
    { amount: 700, from, until: (SEC + 60) * 1000 },
    { amount: 500, from: CREATED + 3_600_000, until: null },
  ]);
  const byId = Object.fromEntries(got.map((x) => [x.id, x.contested]));
  assert.deepEqual(byId, { '1': true, '2': false, '3': false });
});

test('a contested exact arrival is never matched automatically, and the owner is told why', async () => {
  // An API transfer of the same amount landed after this manual pledge was made, and was confirmed
  // by the server without a reference. Its arrival must not be counted again for this pledge.
  const rivals = [{ amount: 700, from: CREATED + 10_000, until: CREATED + 600_000 }];
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { rivals })));
  assert.equal(err.details.verification.outcome, 'several');
  assert.equal(err.details.verification.receipts?.[0].contested, true);
  assert.match(err.message, /another pledge of the same amount could account for that transfer/);
  // The owner can still choose it, deliberately.
  const got = await checkReceipt(input([row(1, 700, 45)], { rivals, choice: '1' }));
  assert.equal(got.transactionId, '1');
});

test('another donor still waiting with the same amount makes an arrival contested', async () => {
  const rivals = [{ amount: 700, from: CREATED - 1000, until: null }];
  const err = await refusal(checkReceipt(input([row(1, 700, 45)], { rivals })));
  assert.equal(err.details.verification.outcome, 'several');
});

test('the ledger: recorded ids are used, unrecorded pledges are rivals, cancelled ones are neither', () => {
  const at = (s: number) => new Date(CREATED + s * 1000).toISOString();
  const p = (over: Partial<Pledge>): Pledge => ({ ...base, createdAt: at(0), updatedAt: at(0), ...over });
  const ledger = receiptLedger([
    p({ id: 'self', status: 'sent' }),
    p({ id: 'a', status: 'confirmed', transactionId: '55', receivedAmount: 500, amountVerified: true }),
    p({ id: 'b', status: 'confirmed', method: 'api', amount: 300, transferredAt: at(5), updatedAt: at(5) }),
    p({ id: 'c', status: 'sent', amount: 200, createdAt: at(10) }),
    p({ id: 'd', status: 'cancelled', amount: 900 }),
    p({ id: 'e', status: 'confirmed', amount: 400, receivedAmount: 0, createdAt: 'garbage' }),
  ], 'self');
  assert.deepEqual([...ledger.used], ['55']);
  // An API pledge stays a rival even with a reference, which would name a row in the donor's log.
  const api = receiptLedger([p({ id: 'f', status: 'confirmed', method: 'api', amount: 300, transactionId: '77', updatedAt: at(5) })], 'self');
  assert.deepEqual([...api.used], ['77']);
  assert.equal(api.rivals.length, 1);
  assert.deepEqual(ledger.rivals, [
    // An API transfer: bounded by when the server saw RIPE accept it, not by its last write.
    { amount: 300, from: CREATED, until: CREATED + 5000 + RECEIPT_CLOCK_SKEW_MS },
    { amount: 200, from: CREATED + 10_000, until: null },
  ]);
});

test('a later write to a pledge does not hold an API transfer\'s window open', () => {
  // Seen on dev: deleting the donor's profile rewrote the name on an API pledge, moving updatedAt,
  // and a later arrival of the same amount was put to the owner instead of being matched.
  const at = (s: number) => new Date(CREATED + s * 1000).toISOString();
  const apiPledge = { ...base, id: 'api', method: 'api' as const, status: 'confirmed' as const, amount: 100, createdAt: at(0), transferredAt: at(3), updatedAt: at(120) };
  const { rivals } = receiptLedger([apiPledge], 'self');
  assert.deepEqual(rivals, [{ amount: 100, from: CREATED, until: CREATED + 3000 + RECEIPT_CLOCK_SKEW_MS }]);
  const later = incomingReceipts([row(1, 100, 300)], CREATED, new Set(), rivals);
  assert.equal(later[0].contested, false);
  const sameMoment = incomingReceipts([row(2, 100, 3)], CREATED, new Set(), rivals);
  assert.equal(sameMoment[0].contested, true);
  // An uncertain API transfer the owner confirmed has no transferredAt: its last write bounds it.
  const uncertain = receiptLedger([{ ...apiPledge, transferredAt: '' }], 'self');
  assert.equal(uncertain.rivals[0].until, CREATED + 120_000 + RECEIPT_INDEXING_SLACK_MS);
  // A manual pledge confirmed without a check keeps the wider bound.
  const manual = receiptLedger([{ ...apiPledge, method: 'manual' as const, transferredAt: '' }], 'self');
  assert.equal(manual.rivals[0].until, CREATED + 120_000 + RECEIPT_INDEXING_SLACK_MS);
});

test('a project confirmation lock frees itself once no request could still hold it', () => {
  const asOf = Date.parse('2026-10-01T12:00:00.000Z');
  assert.equal(confirmLockStale(new Date(asOf - 5_000).toISOString(), asOf), false);
  assert.equal(confirmLockStale(new Date(asOf - 10 * 60_000).toISOString(), asOf), true);
  assert.equal(confirmLockStale('garbage', asOf), true);
});

test('a receipt reservation is final once its pledge records the transaction, and frees itself otherwise', () => {
  const asOf = Date.parse('2026-10-01T12:00:00.000Z');
  const recent = new Date(asOf - 10_000).toISOString();
  const old = new Date(asOf - 10 * 60_000).toISOString();
  const holder = { ...base, status: 'confirmed' as const, transactionId: '9', receivedAmount: 700, amountVerified: true };
  assert.equal(receiptReservationReclaimable(old, holder, '9', asOf), false, 'recorded, so taken for good');
  // A request still running: its pledge has not been written yet.
  assert.equal(receiptReservationReclaimable(recent, { ...base, status: 'sent' }, '9', asOf), false);
  // A write that never landed leaves the reservation behind; once no request could still be running, it is free.
  assert.equal(receiptReservationReclaimable(old, { ...base, status: 'sent' }, '9', asOf), true);
  assert.equal(receiptReservationReclaimable(old, null, '9', asOf), true);
  assert.equal(receiptReservationReclaimable('garbage', null, '9', asOf), true);
  // Confirmed against a different transaction does not hold this one.
  assert.equal(receiptReservationReclaimable(old, { ...holder, transactionId: '8' }, '9', asOf), true);
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
