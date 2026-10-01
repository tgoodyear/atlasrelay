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

test('renews the lease and reports a renewal that fails', async () => {
  let renewals = 0;
  const { fetchImpl } = fakeBlob((c) => {
    if (!c.url.includes('comp=lease')) return 201;
    const action = c.headers['x-ms-lease-action'];
    if (action === 'acquire') return 201;
    if (action === 'renew') return ++renewals === 1 ? 200 : 409;
    return 200;
  });
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(CONTAINER, 'token', { fetchImpl, renewMs: 5, log: (l) => lines.push(l) });
  await new Promise((r) => setTimeout(r, 60));
  await lock.release();
  assert.ok(renewals >= 2);
  assert.equal(lock.lost(), true);
  assert.equal(lines.filter((l) => l.includes('could not renew')).length, 1);
});
