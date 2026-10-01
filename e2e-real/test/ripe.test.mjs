import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RipeError, pollUntil, ripeClient, shortSide } from '../lib/ripe.mjs';

// A fake key, and a fake RIPE Atlas answering from a table: nothing here reaches the network.
const KEY = '11111111-2222-4333-8444-555555555555';

/**
 * @param {Record<string, { status: number, body?: unknown } | Error>} answers by "METHOD path"
 */
function fakeRipe(answers) {
  /** @type {{ method: string, url: string, headers: Record<string, string>, body?: string }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), headers: /** @type {Record<string, string>} */ (init.headers), body: /** @type {string | undefined} */ (init.body) });
    const answer = answers[`${method} ${u.pathname}`];
    if (!answer) throw new Error(`no answer for ${method} ${u.pathname}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
  };
  const client = ripeClient(KEY, { label: 'the test key', base: 'https://ripe.test/api/v2', fetchImpl });
  return { client, calls };
}

const forbidden = { status: 403, body: { error: { status: 403, detail: 'You do not have permission to perform this action.' } } };

test('balance reads current_balance with the key in the Authorization header', async () => {
  const { client, calls } = fakeRipe({ 'GET /api/v2/credits/': { status: 200, body: { current_balance: 1234 } } });
  assert.equal(await client.balance(), 1234);
  assert.equal(calls[0].headers.authorization, `Key ${KEY}`);
});

test('errors name the key by its label and RIPE\'s reason, never by its value', async () => {
  const { client } = fakeRipe({ 'GET /api/v2/credits/': forbidden, 'POST /api/v2/credits/transfers/': new TypeError('fetch failed') });
  await assert.rejects(client.balance(), (err) => {
    assert.ok(err instanceof RipeError);
    assert.equal(err.status, 403);
    assert.match(err.message, /^the test key: reading the balance: HTTP 403: You do not have permission/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  await assert.rejects(client.transfer('someone@example.org', 5), (err) => {
    assert.equal(/** @type {RipeError} */ (err).status, 0);
    assert.ok(!/** @type {Error} */ (err).message.includes(KEY));
    return true;
  });
});

test('canRead and canTransfer tell a missing permission from a failure', async () => {
  const allowed = fakeRipe({
    'GET /api/v2/credits/': { status: 200, body: { current_balance: 0 } },
    'POST /api/v2/credits/transfers/': { status: 400, body: { error: { detail: 'This field is required.' } } },
  });
  assert.equal(await allowed.client.canRead(), true);
  assert.equal(await allowed.client.canTransfer(), true);
  // The probe asks for no amount and names no recipient.
  assert.deepEqual(JSON.parse(allowed.calls[1].body ?? ''), {});

  const denied = fakeRipe({ 'GET /api/v2/credits/': forbidden, 'POST /api/v2/credits/transfers/': { status: 401 } });
  assert.equal(await denied.client.canRead(), false);
  assert.equal(await denied.client.canTransfer(), false);

  const broken = fakeRipe({ 'GET /api/v2/credits/': { status: 503 }, 'POST /api/v2/credits/transfers/': { status: 201, body: {} } });
  await assert.rejects(broken.client.canRead(), /HTTP 503/);
  await assert.rejects(broken.client.canTransfer(), /HTTP 201/);
});

test('transfer posts the recipient and amount once, and a refusal keeps RIPE\'s status', async () => {
  const ok = fakeRipe({ 'POST /api/v2/credits/transfers/': { status: 201, body: { transaction: 'x' } } });
  await ok.client.transfer('recipient@example.org', 100);
  assert.equal(ok.calls.length, 1);
  assert.deepEqual(JSON.parse(ok.calls[0].body ?? ''), { recipient: 'recipient@example.org', amount: 100 });

  const refused = fakeRipe({ 'POST /api/v2/credits/transfers/': { status: 400, body: { error: { detail: 'Insufficient credits.' } } } });
  await assert.rejects(refused.client.transfer('recipient@example.org', 100), (err) => {
    assert.equal(/** @type {RipeError} */ (err).status, 400);
    assert.match(/** @type {Error} */ (err).message, /Insufficient credits\./);
    return true;
  });
  assert.equal(refused.calls.length, 1);
});

test('transfersSince keeps the rows from that second on, from a list or a page of results', async () => {
  const since = Date.UTC(2026, 8, 30, 12, 0, 0, 750);
  const s = Math.floor(since / 1000);
  const rows = [
    { id: 3, type: 'admin', amount: -100, date: s + 5 },
    { id: 2, type: 'admin', amount: 100, date: s },
    { id: 1, type: 'admin', amount: -7, date: s - 1 },
    { id: 0, type: 'admin', amount: 'x', date: s + 1 },
  ];
  const listed = fakeRipe({ 'GET /api/v2/credits/transactions/': { status: 200, body: rows } });
  assert.deepEqual(await listed.client.transfersSince(since), [
    { amount: -100, date: (s + 5) * 1000 },
    { amount: 100, date: s * 1000 },
  ]);
  assert.match(listed.calls[0].url, /type=admin/);
  const paged = fakeRipe({ 'GET /api/v2/credits/transactions/': { status: 200, body: { results: rows } } });
  assert.equal((await paged.client.transfersSince(since)).length, 2);
});

test('shortSide picks the smaller balance, the recipient on a tie', () => {
  assert.equal(shortSide({ donor: 10_000, recipient: 0 }), 'recipient');
  assert.equal(shortSide({ donor: 5, recipient: 50 }), 'donor');
  assert.equal(shortSide({ donor: 7, recipient: 7 }), 'recipient');
});

test('pollUntil stops when the value is right, or at the deadline with the last value', async () => {
  let n = 0;
  assert.equal(await pollUntil(async () => ++n, (v) => v >= 3, { intervalMs: 1 }), 3);
  assert.equal(await pollUntil(async () => 0, (v) => v > 0, { timeoutMs: 20, intervalMs: 5 }), 0);
});
