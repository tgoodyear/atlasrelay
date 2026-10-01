// One run at a time, whoever started it. The workflow's concurrency group only covers runs it
// starts; scripts/run-e2e.sh starts the same job from a laptop, and Container Apps runs two
// executions of a manual job side by side. Two runs would sign the same accounts in, delete each
// other's profiles and misread each other's credit transfers, so every run holds a lease on one
// blob in the results container while it signs in and moves credits.
//
// The lease lasts 60 seconds and is renewed every 20, so a run that dies (the replica timeout, an
// out-of-memory kill) frees the lock within a minute; nobody has to break it by hand. A run that
// cannot renew it (the blob service says the lease is gone, or two renewals in a row fail) has lost
// the lock: onLost is called once, and run.mjs stops the suite.
import { randomUUID } from 'node:crypto';

export const LOCK_BLOB = 'locks/full-flow';
const LEASE_SECONDS = 60;
const RENEW_MS = 20_000;
/** Failed renewals in a row after which the lease counts as lost. After two, at most 20 s of it remain (10 s if the last one hung). */
const MISSES = 2;

/**
 * @typedef {{ release: () => Promise<void>, lost: () => boolean }} Lock
 */

/**
 * Takes the lock, waiting up to waitMs for a run that holds it to finish.
 * @param {string} containerUrl e.g. https://account.blob.core.windows.net/results
 * @param {string} token for https://storage.azure.com/
 * @param {{ waitMs?: number, pollMs?: number, renewMs?: number, fetchImpl?: typeof fetch, log?: (line: string) => void, onLost?: () => void }} [opts]
 * @returns {Promise<Lock>}
 */
export async function acquireLock(containerUrl, token, opts = {}) {
  const { waitMs = 120_000, pollMs = 15_000, renewMs = RENEW_MS, fetchImpl = fetch, log = () => {}, onLost = () => {} } = opts;
  const url = `${containerUrl.replace(/\/$/, '')}/${LOCK_BLOB}`;
  const headers = { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' };

  // The blob exists once; later runs find it there (409) or leased by a running one (412).
  const created = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...headers, 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', 'Content-Type': 'text/plain' },
    body: new Uint8Array(0),
  });
  if (!created.ok && created.status !== 409 && created.status !== 412) {
    throw new Error(`Creating the lock ${LOCK_BLOB}: HTTP ${created.status} ${created.headers.get('x-ms-error-code') ?? ''}`.trim());
  }

  const leaseId = randomUUID();
  /** @param {'acquire' | 'renew' | 'release'} action */
  const lease = (action) =>
    fetchImpl(`${url}?comp=lease`, {
      method: 'PUT',
      headers: {
        ...headers,
        'x-ms-lease-action': action,
        ...(action === 'acquire' ? { 'x-ms-lease-duration': String(LEASE_SECONDS), 'x-ms-proposed-lease-id': leaseId } : { 'x-ms-lease-id': leaseId }),
      },
      // A renewal that hangs counts as failed long before the lease runs out.
      signal: AbortSignal.timeout(10_000),
    });

  const deadline = Date.now() + waitMs;
  for (let waited = false; ; waited = true) {
    const res = await lease('acquire');
    if (res.status === 201) break;
    if (res.status !== 409) {
      throw new Error(`Taking the lock ${LOCK_BLOB}: HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim());
    }
    if (Date.now() + pollMs > deadline) {
      throw new Error(`Another run of the full-flow tests holds the lock ${LOCK_BLOB} in the results container. Wait for it to finish and start this one again.`);
    }
    if (!waited) log(`another run holds the lock ${LOCK_BLOB}; waiting up to ${Math.round(waitMs / 1000)} s for it`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  let lost = false;
  let misses = 0;
  /** @param {string} why */
  const lose = (why) => {
    if (lost) return;
    lost = true;
    clearInterval(timer);
    log(`error: lost the lock ${LOCK_BLOB} (${why}); another run could start`);
    onLost();
  };
  const timer = setInterval(async () => {
    if (lost) return;
    let why;
    try {
      const res = await lease('renew');
      if (res.status === 200) {
        misses = 0;
        return;
      }
      why = `HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim();
      // 409 and 412 are final: the lease expired, or another run holds the blob now.
      if (res.status === 409 || res.status === 412) return lose(`renewing it answered ${why}`);
    } catch (err) {
      why = /** @type {Error} */ (err).message;
    }
    // Anything else (no answer, a server error) may pass, and the lease may still be ours.
    if (++misses >= MISSES) lose(`${misses} renewals in a row failed, the last with ${why}`);
    else log(`warning: could not renew the lock ${LOCK_BLOB} (${why}); trying again`);
  }, renewMs);
  timer.unref();

  return {
    lost: () => lost,
    async release() {
      clearInterval(timer);
      if (lost) return;
      try {
        const res = await lease('release');
        if (res.status !== 200) log(`warning: releasing the lock ${LOCK_BLOB}: HTTP ${res.status}; it frees itself within ${LEASE_SECONDS} s`);
      } catch (err) {
        log(`warning: releasing the lock ${LOCK_BLOB}: ${/** @type {Error} */ (err).message}; it frees itself within ${LEASE_SECONDS} s`);
      }
    },
  };
}
