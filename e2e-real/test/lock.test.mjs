import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCK_BLOB, acquireLock } from '../lib/lock.mjs';

// A fake blob service answering from a script: nothing here reaches the network.
const CONTAINER = 'https://results.test/results';

/**
 * @param {(call: { method: string, url: string, headers: Record<string, string> }) => number} answer
 */
function fakeBlob(answer) {
  /** @type {{ method: string, url: string, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url), headers: /** @type {Record<string, string>} */ (init.headers) };
    calls.push(call);
    return new Response('', { status: answer(call) });
  };
  return { fetchImpl, calls };
}

test('takes a 60-second lease on the lock blob and releases it with the same id', async () => {
  const { fetchImpl, calls } = fakeBlob((c) => (!c.url.includes('comp=lease') ? 409 : c.headers['x-ms-lease-action'] === 'acquire' ? 201 : 200));
  const lock = await acquireLock(CONTAINER, 'token', { fetchImpl });
  await lock.release();
  assert.equal(calls[0].url, `${CONTAINER}/${LOCK_BLOB}`);
  assert.equal(calls[0].headers['If-None-Match'], '*');
  const acquire = calls.find((c) => c.headers['x-ms-lease-action'] === 'acquire');
  const release = calls.find((c) => c.headers['x-ms-lease-action'] === 'release');
  assert.equal(acquire?.headers['x-ms-lease-duration'], '60');
  assert.ok(acquire?.headers['x-ms-proposed-lease-id']);
  assert.equal(release?.headers['x-ms-lease-id'], acquire?.headers['x-ms-proposed-lease-id']);
  assert.equal(lock.lost(), false);
});

test('waits for a lease another run holds, then takes it', async () => {
  let tries = 0;
  const { fetchImpl } = fakeBlob((c) => {
    if (!c.url.includes('comp=lease')) return 412;
    if (c.headers['x-ms-lease-action'] !== 'acquire') return 200;
    tries++;
    return tries < 3 ? 409 : 201;
  });
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(CONTAINER, 'token', { fetchImpl, waitMs: 1000, pollMs: 10, log: (l) => lines.push(l) });
  await lock.release();
  assert.equal(tries, 3);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /another run holds the lock/);
});

test('gives up when the other run keeps the lock', async () => {
  const { fetchImpl } = fakeBlob((c) => (c.url.includes('comp=lease') ? 409 : 201));
  await assert.rejects(acquireLock(CONTAINER, 'token', { fetchImpl, waitMs: 50, pollMs: 10 }), /Another run of the full-flow tests holds the lock/);
});

test('any other answer is an error, not a wait', async () => {
  const { fetchImpl } = fakeBlob((c) => (c.url.includes('comp=lease') ? 403 : 201));
  await assert.rejects(acquireLock(CONTAINER, 'token', { fetchImpl, waitMs: 60_000, pollMs: 10 }), /Taking the lock .*HTTP 403/);
  const { fetchImpl: denied } = fakeBlob(() => 403);
  await assert.rejects(acquireLock(CONTAINER, 'token', { fetchImpl: denied }), /Creating the lock .*HTTP 403/);
});

/**
 * Takes the lock against a blob service whose renewals answer from `renewals` in turn (200 after
 * the list runs out), lets it renew a few times, and reports what the lock saw.
 * @param {(number | Error)[]} renewals
 */
async function renewing(renewals) {
  let n = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const action = /** @type {Record<string, string>} */ (init.headers)['x-ms-lease-action'];
    if (!String(url).includes('comp=lease') || action === 'acquire') return new Response('', { status: 201 });
    if (action !== 'renew') return new Response('', { status: 200 });
    const answer = renewals[n++] ?? 200;
    if (answer instanceof Error) throw answer;
    return new Response('', { status: answer });
  };
  /** @type {string[]} */
  const lines = [];
  let lostCalls = 0;
  const lock = await acquireLock(CONTAINER, 'token', { fetchImpl, renewMs: 5, log: (l) => lines.push(l), onLost: () => lostCalls++ });
  await new Promise((r) => setTimeout(r, 80));
  await lock.release();
  return { lost: lock.lost(), lostCalls, lines, renewals: n };
}

test('keeps the lock through renewals that pass', async () => {
  const r = await renewing([]);
  assert.ok(r.renewals >= 3);
  assert.equal(r.lost, false);
  assert.equal(r.lostCalls, 0);
});

test('a renewal the blob service refuses loses the lock at once, and says so once', async () => {
  const r = await renewing([200, 409]);
  assert.equal(r.lost, true);
  assert.equal(r.lostCalls, 1);
  assert.equal(r.renewals, 2);
  assert.deepEqual(r.lines.filter((l) => l.startsWith('error:')).length, 1);
  assert.match(r.lines.find((l) => l.startsWith('error:')) ?? '', /lost the lock .*HTTP 409/);
});

test('one failed renewal is retried; two in a row lose the lock', async () => {
  const once = await renewing([new TypeError('fetch failed'), 200, 503, 200]);
  assert.equal(once.lost, false);
  assert.equal(once.lines.filter((l) => l.startsWith('warning: could not renew')).length, 2);
  const twice = await renewing([200, 503, new TypeError('fetch failed')]);
  assert.equal(twice.lost, true);
  assert.equal(twice.lostCalls, 1);
  assert.match(twice.lines.find((l) => l.startsWith('error:')) ?? '', /2 renewals in a row failed, the last with fetch failed/);
});
