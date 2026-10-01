// One full-flow run on dev at a time, whoever started it. dev is one site, one API and one set of
// tables, shared by every run: a run deploys its build there, then signs the two test accounts in
// and moves real RIPE Atlas credits. Two runs at once would test each other's builds, sign the
// same accounts in, delete each other's profiles and misread each other's transfers. So every run
// holds a lease on one blob, `full-flow` in the `locks` container of the results storage account,
// from before it deploys until its tests end.
//
// The orchestrator (scripts/run-e2e.sh, or the workflow e2e-dev.yml) takes the lease with
// acquireLock, through e2e-real/lock-holder.mjs, before it deploys. It hands the lease id to the
// test job (E2E_LOCK_LEASE_ID), and the job renews that same lease with adoptLock while its tests
// run; it never takes a lease of its own then, and it leaves the release to the orchestrator. A job
// started without a lease id (from the portal, say) takes one with acquireLock, as before.
//
// The lease lasts 60 seconds and every holder renews it every 20, so when every holder dies (the
// replica timeout, an out-of-memory kill, a laptop closed mid-run) the lock frees itself within a
// minute; nobody has to break it by hand. A holder that cannot renew it (the blob service says the
// lease is gone, or two renewals in a row fail) has lost the lock: onLost is called once.
import { randomUUID } from 'node:crypto';

export const LOCK_CONTAINER = 'locks';
export const LOCK_BLOB = 'full-flow';
export const LEASE_SECONDS = 60;
const RENEW_MS = 20_000;
/** Failed renewals in a row after which the lease counts as lost. */
const MISSES = 2;
/**
 * A renewal (its token included) that has not finished in this long counts as failed. With two
 * misses in a row, or 40 s since the last renewal that worked, the holder counts the lease as
 * lost: within 50 s of that renewal, before the 60 s it bought run out. It never believes it holds
 * a lease that has expired.
 */
const REQUEST_MS = 10_000;
/** How long a run waits for another to finish. A whole run (deploy, build, 45 minutes of tests) fits. */
export const WAIT_MS = 45 * 60_000;
const POLL_MS = 30_000;
/** While waiting, a reminder this often. */
const NOTE_MS = 5 * 60_000;

/**
 * @typedef {{ leaseId: string, release: () => Promise<void>, lost: () => boolean }} Lock
 * @typedef {string | (() => Promise<string>)} TokenSource a token for https://storage.azure.com/, or a function that returns a current one
 * @typedef {{ runId?: string, gitSha?: string }} Holder what the holder writes on the blob for others to read while they wait
 * @typedef {{ renewMs?: number, requestMs?: number, lostAfterMs?: number, fetchImpl?: typeof fetch, log?: (line: string) => void, onLost?: () => void }} HoldOptions
 */

/** @param {string} containerUrl e.g. https://account.blob.core.windows.net/locks @returns {string} the lock blob's URL */
export function lockBlobUrl(containerUrl) {
  return `${containerUrl.replace(/\/$/, '')}/${LOCK_BLOB}`;
}

/** @param {string} s keeps metadata values to characters a header can carry */
function metaValue(s) {
  return s.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100);
}

/**
 * @param {string} blobUrl
 * @param {TokenSource} token
 * @param {typeof fetch} fetchImpl
 */
function blobClient(blobUrl, token, fetchImpl) {
  const name = new URL(blobUrl).pathname.replace(/^\//, '');
  /** @param {Record<string, string>} extra */
  const headers = async (extra) => ({
    Authorization: `Bearer ${typeof token === 'string' ? token : await token()}`,
    'x-ms-version': '2023-11-03',
    ...extra,
  });
  return {
    name,
    /**
     * @param {'acquire' | 'renew' | 'release'} action
     * @param {string} leaseId
     */
    async lease(action, leaseId) {
      return fetchImpl(`${blobUrl}?comp=lease`, {
        method: 'PUT',
        headers: await headers({
          'x-ms-lease-action': action,
          ...(action === 'acquire' ? { 'x-ms-lease-duration': String(LEASE_SECONDS), 'x-ms-proposed-lease-id': leaseId } : { 'x-ms-lease-id': leaseId }),
        }),
        // A request that hangs counts as failed long before the lease runs out.
        signal: AbortSignal.timeout(10_000),
      });
    },
    /** The blob exists once; later runs find it there (409) or leased by a running one (412). */
    async create() {
      const res = await fetchImpl(blobUrl, {
        method: 'PUT',
        headers: await headers({ 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', 'Content-Type': 'text/plain' }),
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status !== 409 && res.status !== 412) {
        throw new Error(`Creating the lock ${name}: HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim());
      }
    },
    /**
     * @param {string} leaseId
     * @param {Record<string, string>} meta
     */
    async setMetadata(leaseId, meta) {
      /** @type {Record<string, string>} */
      const extra = { 'x-ms-lease-id': leaseId };
      for (const [k, v] of Object.entries(meta)) extra[`x-ms-meta-${k}`] = metaValue(v);
      return fetchImpl(`${blobUrl}?comp=metadata`, { method: 'PUT', headers: await headers(extra), signal: AbortSignal.timeout(10_000) });
    },
    /** @returns {Promise<{ leased: boolean, runId: string, gitSha: string, since: string } | null>} */
    async holder() {
      const res = await fetchImpl(blobUrl, { method: 'HEAD', headers: await headers({}), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return {
        leased: res.headers.get('x-ms-lease-state') === 'leased',
        runId: res.headers.get('x-ms-meta-runid') ?? '',
        gitSha: res.headers.get('x-ms-meta-gitsha') ?? '',
        since: res.headers.get('x-ms-meta-since') ?? '',
      };
    },
  };
}

/** @param {number} ms */
function minutes(ms) {
  const n = Math.round(ms / 60_000);
  return `${n} minute${n === 1 ? '' : 's'}`;
}

/** @param {{ leased: boolean, runId: string, gitSha: string, since: string } | null} h */
function describe(h) {
  // The labels outlive a release, so they name the holder only while the blob is leased.
  if (!h || !h.leased || !h.runId) return 'another run';
  const about = [h.gitSha && `commit ${h.gitSha.slice(0, 12)}`, h.since && `since ${h.since}`].filter(Boolean).join(', ');
  return `run ${h.runId}${about ? ` (${about})` : ''}`;
}

/**
 * Renews a lease every renewMs until release() or until it is lost.
 * @param {ReturnType<typeof blobClient>} blob
 * @param {string} leaseId
 * @param {HoldOptions & { releaseAtEnd: boolean }} opts
 * @returns {Lock}
 */
function hold(blob, leaseId, opts) {
  const { renewMs = RENEW_MS, log = () => {}, onLost = () => {}, releaseAtEnd } = opts;
  const lostAfterMs = opts.lostAfterMs ?? 2 * renewMs;
  const requestMs = opts.requestMs ?? Math.min(REQUEST_MS, renewMs / 2);
  let lost = false;
  let ended = false;
  let misses = 0;
  let inFlight = false;
  let lastOk = Date.now();
  /** @param {string} why */
  const lose = (why) => {
    if (lost || ended) return;
    lost = true;
    clearInterval(timer);
    log(`error: lost the lock ${blob.name} (${why}); another run could start`);
    onLost();
  };
  const timer = setInterval(async () => {
    if (lost || ended) return;
    // However the last renewal is doing, a lease not renewed for this long may be gone.
    if (Date.now() - lastOk >= lostAfterMs) return lose(`not renewed for ${Math.round((Date.now() - lastOk) / 1000)} s`);
    if (inFlight) return;
    inFlight = true;
    let why;
    try {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let t;
      const res = await Promise.race([
        blob.lease('renew', leaseId),
        new Promise((_, reject) => {
          t = setTimeout(() => reject(new Error(`no answer in ${requestMs / 1000} s`)), requestMs);
        }),
      ]).finally(() => clearTimeout(t));
      if (ended) return;
      if (res.status === 200) {
        misses = 0;
        lastOk = Date.now();
        return;
      }
      why = `HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim();
      // 409 and 412 are final: the lease expired and was taken, was released, or never was this one.
      if (res.status === 409 || res.status === 412) return lose(`renewing it answered ${why}`);
    } catch (err) {
      why = /** @type {Error} */ (err).message;
    } finally {
      inFlight = false;
    }
    if (ended || lost) return;
    // Anything else (no answer, a server error, no token) may pass, and the lease may still be ours.
    if (++misses >= MISSES) lose(`${misses} renewals in a row failed, the last with ${why}`);
    else log(`warning: could not renew the lock ${blob.name} (${why}); trying again`);
  }, renewMs);
  timer.unref();

  return {
    leaseId,
    lost: () => lost,
    async release() {
      ended = true;
      clearInterval(timer);
      if (lost || !releaseAtEnd) return;
      try {
        const res = await blob.lease('release', leaseId);
        if (res.status !== 200) log(`warning: releasing the lock ${blob.name}: HTTP ${res.status}; it frees itself within ${LEASE_SECONDS} s`);
      } catch (err) {
        log(`warning: releasing the lock ${blob.name}: ${/** @type {Error} */ (err).message}; it frees itself within ${LEASE_SECONDS} s`);
      }
    },
  };
}

/**
 * Takes the lock, waiting up to waitMs for a run that holds it to finish, and renews it until
 * release(), which gives it up.
 * @param {string} blobUrl the lock blob, lockBlobUrl(<locks container URL>)
 * @param {TokenSource} token
 * @param {HoldOptions & { waitMs?: number, pollMs?: number, noteMs?: number, holder?: Holder, now?: () => Date }} [opts]
 * @returns {Promise<Lock>}
 */
export async function acquireLock(blobUrl, token, opts = {}) {
  const { waitMs = WAIT_MS, pollMs = POLL_MS, noteMs = NOTE_MS, fetchImpl = fetch, log = () => {}, holder = {}, now = () => new Date() } = opts;
  const blob = blobClient(blobUrl, token, fetchImpl);
  await blob.create();

  const leaseId = randomUUID();
  const start = Date.now();
  const deadline = start + waitMs;
  let lastSeen = '';
  let lastNote = start;
  for (;;) {
    /** @type {string} */
    let seen;
    try {
      const res = await blob.lease('acquire', leaseId);
      if (res.status === 201) break;
      // 409: someone holds it. A server error or throttling may pass; anything else will not.
      if (res.status !== 409 && res.status !== 429 && res.status < 500) {
        throw new Error(`Taking the lock ${blob.name}: HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim());
      }
      seen = res.status === 409 ? describe(await blob.holder().catch(() => null)) : '';
      if (!seen) log(`warning: taking the lock ${blob.name} answered HTTP ${res.status}; trying again`);
    } catch (err) {
      if (/** @type {Error} */ (err).message.startsWith('Taking the lock')) throw err;
      // No answer, or no token: try again at the next poll.
      log(`warning: taking the lock ${blob.name}: ${/** @type {Error} */ (err).message}; trying again`);
      seen = '';
    }
    if (Date.now() + pollMs > deadline) {
      const who = seen || lastSeen || 'another run';
      throw new Error(`${who[0].toUpperCase()}${who.slice(1)} still holds the lock ${blob.name} after ${minutes(waitMs)} of waiting. Start this run again once it has finished.`);
    }
    if (seen && seen !== lastSeen) {
      log(`${seen} holds the lock ${blob.name}; waiting for it, for up to ${minutes(deadline - Date.now())} more, checking every ${Math.round(pollMs / 1000)} s`);
      lastSeen = seen;
      lastNote = Date.now();
    } else if (seen && Date.now() - lastNote >= noteMs) {
      log(`still waiting for ${seen} (${minutes(Date.now() - start)} so far)`);
      lastNote = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Who holds it, for anyone who waits. Only identifiers of the run, never a person's.
  try {
    const res = await blob.setMetadata(leaseId, {
      runid: holder.runId ?? '',
      gitsha: holder.gitSha ?? '',
      since: now().toISOString().replace(/\.\d+Z$/, 'Z'),
    });
    if (!res.ok) log(`warning: could not label the lock with this run (HTTP ${res.status}); runs that wait will not see who holds it`);
  } catch (err) {
    log(`warning: could not label the lock with this run (${/** @type {Error} */ (err).message})`);
  }
  return hold(blob, leaseId, { ...opts, releaseAtEnd: true });
}

/**
 * Keeps renewing a lease someone else took (the orchestrator, for the test job). It never takes a
 * lease of its own, and release() only stops renewing: the one who took it releases it.
 * @param {string} blobUrl
 * @param {TokenSource} token
 * @param {string} leaseId
 * @param {HoldOptions & { holder?: Holder, now?: () => Date }} [opts]
 * @returns {Promise<Lock>}
 */
export async function adoptLock(blobUrl, token, leaseId, opts = {}) {
  const { fetchImpl = fetch, log = () => {}, holder = {}, now = () => new Date() } = opts;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaseId)) {
    throw new Error('E2E_LOCK_LEASE_ID is not a lease id');
  }
  const blob = blobClient(blobUrl, token, fetchImpl);
  // One renewal first: the lease must still be the one the orchestrator took. A job that waited
  // for capacity after its orchestrator died finds it gone here, and stops before signing in.
  let why = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await blob.lease('renew', leaseId);
      if (res.status === 200) {
        const lock = hold(blob, leaseId, { ...opts, releaseAtEnd: false });
        // Tells an orchestrator that started this run and does not wait for it (run-e2e.sh
        // --no-wait) that it may stop renewing: the job renews from here on.
        try {
          // Keeps the time the orchestrator took the lock, which waiting runs print.
          const before = await blob.holder().catch(() => null);
          const meta = await blob.setMetadata(leaseId, {
            runid: holder.runId ?? '',
            gitsha: holder.gitSha ?? '',
            since: before?.since || now().toISOString().replace(/\.\d+Z$/, 'Z'),
            adopted: holder.runId ?? 'yes',
          });
          if (!meta.ok) log(`warning: could not mark the lock as taken over by the job (HTTP ${meta.status})`);
        } catch (err) {
          log(`warning: could not mark the lock as taken over by the job (${/** @type {Error} */ (err).message})`);
        }
        return lock;
      }
      why = `HTTP ${res.status} ${res.headers.get('x-ms-error-code') ?? ''}`.trim();
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      why = /** @type {Error} */ (err).message;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`The lock ${blob.name} is no longer held under the lease this run was started with (${why}); another run may have it now`);
}
