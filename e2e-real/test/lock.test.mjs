import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCK_BLOB, acquireLock, adoptLock, lockBlobUrl } from '../lib/lock.mjs';

// A fake blob service answering from a script: nothing here reaches the network.
const BLOB = lockBlobUrl('https://results.test/locks/');
const LEASE = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** @typedef {{ method: string, url: string, headers: Record<string, string> }} Call */

/**
 * @param {(call: Call) => number | { status: number, headers?: Record<string, string> }} answer
 */
function fakeBlob(answer) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url), headers: /** @type {Record<string, string>} */ (init.headers) };
    calls.push(call);
    const a = answer(call);
    const { status, headers = {} } = typeof a === 'number' ? { status: a } : a;
    return new Response(status === 204 || init.method === 'HEAD' ? null : '', { status, headers });
  };
  return { fetchImpl, calls };
}

/** @param {Call} c */
const action = (c) => (c.url.endsWith('?comp=lease') ? c.headers['x-ms-lease-action'] : c.url.endsWith('?comp=metadata') ? 'metadata' : c.method);

test('the lock is the blob full-flow in the locks container', () => {
  assert.equal(BLOB, 'https://results.test/locks/full-flow');
  assert.equal(LOCK_BLOB, 'full-flow');
});

test('takes a 60-second lease, labels the blob with the run, and releases it with the same id', async () => {
  const { fetchImpl, calls } = fakeBlob((c) => ({ PUT: 409, acquire: 201, metadata: 200, release: 200 })[action(c)] ?? 500);
  const lock = await acquireLock(BLOB, 'token', { fetchImpl, holder: { runId: 'gh-1-1', gitSha: 'abc def' }, now: () => new Date('2026-10-01T12:00:00.123Z') });
  await lock.release();
  assert.equal(calls[0].url, BLOB);
  assert.equal(calls[0].headers['If-None-Match'], '*');
  const acquire = calls.find((c) => action(c) === 'acquire');
  const meta = calls.find((c) => action(c) === 'metadata');
  const release = calls.find((c) => action(c) === 'release');
  assert.equal(acquire?.headers['x-ms-lease-duration'], '60');
  assert.equal(acquire?.headers['x-ms-proposed-lease-id'], lock.leaseId);
  assert.equal(meta?.headers['x-ms-lease-id'], lock.leaseId);
  assert.equal(meta?.headers['x-ms-meta-runid'], 'gh-1-1');
  assert.equal(meta?.headers['x-ms-meta-gitsha'], 'abc-def');
  assert.equal(meta?.headers['x-ms-meta-since'], '2026-10-01T12:00:00Z');
  assert.equal(release?.headers['x-ms-lease-id'], lock.leaseId);
  assert.equal(calls.at(-1), release);
  assert.equal(lock.lost(), false);
});

test('asks for a token per request, so a token function can hand out a fresh one', async () => {
  let n = 0;
  const { fetchImpl, calls } = fakeBlob((c) => ({ PUT: 201, acquire: 201, metadata: 200, release: 200 })[action(c)] ?? 500);
  const lock = await acquireLock(BLOB, async () => `t${++n}`, { fetchImpl });
  await lock.release();
  assert.deepEqual(
    calls.map((c) => c.headers.Authorization),
    calls.map((_, i) => `Bearer t${i + 1}`),
  );
});

test('a label that cannot be written is a warning, not a failure', async () => {
  const { fetchImpl } = fakeBlob((c) => ({ PUT: 201, acquire: 201, metadata: 403, release: 200 })[action(c)] ?? 500);
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(BLOB, 'token', { fetchImpl, log: (l) => lines.push(l) });
  await lock.release();
  assert.match(lines.join('\n'), /could not label the lock .*HTTP 403/);
});

test('waits for a lease another run holds, says who holds it, then takes it', async () => {
  let tries = 0;
  const { fetchImpl } = fakeBlob((c) => {
    if (action(c) === 'HEAD') return { status: 200, headers: { 'x-ms-lease-state': 'leased', 'x-ms-meta-runid': 'local-20261001-120000', 'x-ms-meta-gitsha': '0123456789abcdef', 'x-ms-meta-since': '2026-10-01T12:00:00Z' } };
    if (action(c) !== 'acquire') return 200;
    return ++tries < 4 ? 409 : 201;
  });
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(BLOB, 'token', { fetchImpl, waitMs: 1000, pollMs: 10, noteMs: 60_000, log: (l) => lines.push(l) });
  await lock.release();
  assert.equal(tries, 4);
  // Once per holder, not once per poll.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^run local-20261001-120000 \(commit 0123456789ab, since 2026-10-01T12:00:00Z\) holds the lock locks\/full-flow; waiting/);
});

test('gives up after the wait, naming the holder, and never takes the lease', async () => {
  const { fetchImpl, calls } = fakeBlob((c) =>
    action(c) === 'HEAD' ? { status: 200, headers: { 'x-ms-lease-state': 'leased', 'x-ms-meta-runid': 'gh-9-1' } } : action(c) === 'acquire' ? 409 : 201,
  );
  await assert.rejects(acquireLock(BLOB, 'token', { fetchImpl, waitMs: 50, pollMs: 10 }), /Run gh-9-1 still holds the lock locks\/full-flow after 0 minutes of waiting/);
  assert.ok(!calls.some((c) => ['metadata', 'renew', 'release'].includes(action(c))));
});

test('a holder that cannot be read is "another run"', async () => {
  const { fetchImpl } = fakeBlob((c) => (action(c) === 'HEAD' ? 403 : action(c) === 'acquire' ? 409 : 201));
  await assert.rejects(acquireLock(BLOB, 'token', { fetchImpl, waitMs: 30, pollMs: 10 }), /^Error: Another run still holds the lock/);
});

test('any other answer is an error, not a wait', async () => {
  const { fetchImpl } = fakeBlob((c) => (action(c) === 'acquire' ? 403 : 201));
  await assert.rejects(acquireLock(BLOB, 'token', { fetchImpl, waitMs: 60_000, pollMs: 10 }), /Taking the lock .*HTTP 403/);
  const { fetchImpl: denied } = fakeBlob(() => 403);
  await assert.rejects(acquireLock(BLOB, 'token', { fetchImpl: denied }), /Creating the lock .*HTTP 403/);
});

/**
 * Holds the lock (taken, or adopted with LEASE) against a blob service whose renewals answer from
 * `renewals` in turn (200 after the list runs out), lets it renew a few times, and reports what
 * the lock saw.
 * @param {(number | Error)[]} renewals
 * @param {'acquire' | 'adopt'} [how]
 */
async function renewing(renewals, how = 'acquire', { answerRenew = /** @type {(() => Promise<Response>) | null} */ (null), wait = 80, lostAfterMs = 1000, requestMs = 1000 } = {}) {
  let n = 0;
  /** @type {Call[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url), headers: /** @type {Record<string, string>} */ (init.headers) };
    calls.push(call);
    const a = action(call);
    if (a !== 'renew') return new Response(null, { status: a === 'acquire' || a === 'PUT' ? 201 : 200 });
    if (answerRenew) return answerRenew();
    // adoptLock's first renewal checks the lease; it is not one of the scripted ones.
    if (how === 'adopt' && !calls.slice(0, -1).some((c) => action(c) === 'renew')) return new Response(null, { status: 200 });
    const answer = renewals[n++] ?? 200;
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  };
  /** @type {string[]} */
  const lines = [];
  let lostCalls = 0;
  const opts = { fetchImpl, renewMs: 5, lostAfterMs, requestMs, log: (/** @type {string} */ l) => lines.push(l), onLost: () => lostCalls++, holder: { runId: 'gh-7-1' } };
  const lock = how === 'adopt' ? await adoptLock(BLOB, 'token', LEASE, opts) : await acquireLock(BLOB, 'token', opts);
  await new Promise((r) => setTimeout(r, wait));
  await lock.release();
  return { lost: lock.lost(), lostCalls, lines, renewals: n, calls };
}

test('keeps the lock through renewals that pass', async () => {
  const r = await renewing([]);
  assert.ok(r.renewals >= 3);
  assert.equal(r.lost, false);
  assert.equal(r.lostCalls, 0);
});

test('a renewal the blob service refuses loses the lock at once, and says so once', async () => {
  for (const status of [409, 412]) {
    const r = await renewing([200, status]);
    assert.equal(r.lost, true);
    assert.equal(r.lostCalls, 1);
    assert.equal(r.renewals, 2);
    assert.equal(r.lines.filter((l) => l.startsWith('error:')).length, 1);
    assert.match(r.lines.find((l) => l.startsWith('error:')) ?? '', new RegExp(`lost the lock .*HTTP ${status}`));
    // A lost lease is not released: it is no longer this run's.
    assert.ok(!r.calls.some((c) => action(c) === 'release'));
  }
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

test('a token that cannot be had counts as a failed renewal', async () => {
  let n = 0;
  const { fetchImpl } = fakeBlob((c) => ({ PUT: 201, acquire: 201, metadata: 200, renew: 200, release: 200 })[action(c)] ?? 500);
  let lostCalls = 0;
  // The first three tokens take and label the lock; every later one fails.
  const lock = await acquireLock(
    BLOB,
    async () => {
      if (++n > 3) throw new Error('no token');
      return 't';
    },
    { fetchImpl, renewMs: 5, onLost: () => lostCalls++ },
  );
  await new Promise((r) => setTimeout(r, 60));
  await lock.release();
  assert.equal(lock.lost(), true);
  assert.equal(lostCalls, 1);
});

test('an adopted lease is renewed under its own id, never taken anew, and never released', async () => {
  const r = await renewing([], 'adopt');
  assert.equal(r.lost, false);
  assert.ok(r.renewals >= 3);
  assert.ok(r.calls.every((c) => ['renew', 'metadata'].includes(action(c))), `calls: ${r.calls.map(action).join(', ')}`);
  assert.ok(r.calls.every((c) => c.headers['x-ms-lease-id'] === LEASE));
  // Once, right after the first renewal: the orchestrator may stop renewing from then on.
  const meta = r.calls.filter((c) => action(c) === 'metadata');
  assert.equal(meta.length, 1);
  assert.equal(r.calls.indexOf(meta[0]), 1);
  assert.equal(meta[0].headers['x-ms-meta-adopted'], 'gh-7-1');
  assert.equal(meta[0].headers['x-ms-meta-runid'], 'gh-7-1');
});

test('an adopted lease that is refused later is lost like any other', async () => {
  const r = await renewing([200, 409], 'adopt');
  assert.equal(r.lost, true);
  assert.equal(r.lostCalls, 1);
  assert.ok(!r.calls.some((c) => ['acquire', 'release'].includes(action(c))));
});

test('adopting a lease that is no longer current fails before anything else', async () => {
  for (const status of [409, 412]) {
    const { fetchImpl, calls } = fakeBlob(() => status);
    await assert.rejects(adoptLock(BLOB, 'token', LEASE, { fetchImpl }), /no longer held under the lease this run was started with \(HTTP/);
    assert.deepEqual(calls.map(action), ['renew']);
  }
});

test('adopting retries a renewal that got no answer, then gives up', async () => {
  let n = 0;
  /** @type {typeof fetch} */
  const flaky = async (/** @type {any} */ url) => {
    if (String(url).endsWith('?comp=metadata')) return new Response(null, { status: 200 });
    return ++n === 1 ? Promise.reject(new TypeError('fetch failed')) : new Response(null, { status: 200 });
  };
  const lock = await adoptLock(BLOB, 'token', LEASE, { fetchImpl: flaky, renewMs: 60_000 });
  await lock.release();
  assert.equal(n, 2);
  /** @type {typeof fetch} */
  const dead = async () => Promise.reject(new TypeError('fetch failed'));
  await assert.rejects(adoptLock(BLOB, 'token', LEASE, { fetchImpl: dead }), /no longer held .*fetch failed/);
});

test('adopting refuses something that is not a lease id', async () => {
  const { fetchImpl, calls } = fakeBlob(() => 200);
  await assert.rejects(adoptLock(BLOB, 'token', 'not-a-lease', { fetchImpl }), /not a lease id/);
  assert.equal(calls.length, 0);
});

test('a renewal that hangs counts as failed, and a lease not renewed for too long is lost', async () => {
  // Every renewal hangs: each is given up after requestMs, and the lock is lost on the second.
  const hung = await renewing([], 'acquire', { answerRenew: () => new Promise(() => {}), requestMs: 15, lostAfterMs: 10_000, wait: 120 });
  assert.equal(hung.lost, true);
  assert.equal(hung.lostCalls, 1);
  assert.match(hung.lines.find((l) => l.startsWith('error:')) ?? '', /2 renewals in a row failed, the last with no answer in 0.015 s/);
  // A renewal that hangs longer than the lease could last loses the lock on time, not when it ends.
  const slow = await renewing([], 'acquire', { answerRenew: () => new Promise(() => {}), requestMs: 10_000, lostAfterMs: 40, wait: 120 });
  assert.equal(slow.lost, true);
  assert.match(slow.lines.find((l) => l.startsWith('error:')) ?? '', /not renewed for \d+ s/);
  // Overlapping ticks do not stack requests while one is in flight.
  assert.equal(slow.calls.filter((c) => action(c) === 'renew').length, 1);
});

test('while waiting, a failed request or a server error is tried again, not fatal', async () => {
  let n = 0;
  const { fetchImpl } = fakeBlob((c) => {
    if (action(c) !== 'acquire') return action(c) === 'PUT' ? 201 : 200;
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return n === 2 ? 503 : n === 3 ? 429 : 201;
  });
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(BLOB, 'token', { fetchImpl, waitMs: 1000, pollMs: 5, log: (l) => lines.push(l) });
  await lock.release();
  assert.equal(n, 4);
  assert.equal(lines.filter((l) => l.startsWith('warning: taking the lock')).length, 3);
});

test('a label left by an earlier holder is not shown once the blob is free', async () => {
  let tries = 0;
  const { fetchImpl } = fakeBlob((c) => {
    if (action(c) === 'HEAD') return { status: 200, headers: { 'x-ms-lease-state': 'expired', 'x-ms-meta-runid': 'old-run' } };
    if (action(c) !== 'acquire') return 200;
    return ++tries < 2 ? 409 : 201;
  });
  /** @type {string[]} */
  const lines = [];
  const lock = await acquireLock(BLOB, 'token', { fetchImpl, waitMs: 1000, pollMs: 5, log: (l) => lines.push(l) });
  await lock.release();
  assert.match(lines[0], /^another run holds the lock/);
});
