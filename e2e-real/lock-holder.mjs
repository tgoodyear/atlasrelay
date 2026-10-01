// Holds the full-flow lock (lib/lock.mjs) for an orchestrator: scripts/run-e2e.sh on the owner's
// machine, or the workflow e2e-dev.yml. scripts/lib/e2e-job.sh starts it in the background before
// it deploys anything to dev:
//
//   node e2e-real/lock-holder.mjs --blob-url URL --lease-file PATH --run-id ID --git-sha SHA \
//     --parent-pid PID [--subscription ID]
//
// It waits for the lock (up to 45 minutes, asking every 30 seconds and saying who holds it), then
// writes the lease id to PATH (mode 600) for the orchestrator to hand to the test job, and renews
// the lease every 20 seconds until told to stop:
//
//   SIGUSR1   release the lease and exit 0 (the run is over)
//   SIGUSR2, SIGTERM   stop renewing and exit 0 without releasing (the test job still runs and
//             renews the lease itself; it lapses within 60 seconds of the job ending). A stray
//             SIGTERM (a logout, a shutdown, killall) never frees the lock under a running job.
//   SIGINT, SIGHUP  ignored: Ctrl+C is for the orchestrator, whose trap sends one of the above
//
// It stops on its own, too, and the orchestrator reads why from the exit code:
//
//   2  it never got the lock (waited 45 minutes, or the blob service refused)
//   3  it lost the lock (a renewal refused, or two in a row failed)
//   4  it held the lock for --max-hold-minutes (default 120) and released it
//   5  the orchestrator (--parent-pid) is gone; it stops renewing without releasing
//
// It needs a token for the storage account: from the Azure CLI on the owner's machine (in the
// tenant of --subscription), or from GitHub's OIDC token in a workflow job (lib/token.mjs). It
// never prints the lease id.
import { renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { WAIT_MS, acquireLock } from './lib/lock.mjs';
import { azCliToken, cachedToken, githubFederatedToken } from './lib/token.mjs';

const { values } = parseArgs({
  options: {
    'blob-url': { type: 'string' },
    'lease-file': { type: 'string' },
    'run-id': { type: 'string', default: '' },
    'git-sha': { type: 'string', default: '' },
    'parent-pid': { type: 'string', default: '' },
    subscription: { type: 'string', default: '' },
    'wait-minutes': { type: 'string', default: String(WAIT_MS / 60_000) },
    'max-hold-minutes': { type: 'string', default: '120' },
  },
});
const blobUrl = values['blob-url'] ?? '';
const leaseFile = values['lease-file'] ?? '';
if (!/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(blobUrl) || !leaseFile) {
  process.stderr.write('usage: lock-holder.mjs --blob-url https://<account>.blob.core.windows.net/<container>/<blob> --lease-file PATH [--run-id ID] [--git-sha SHA] [--parent-pid PID]\n');
  process.exit(2);
}
const parentPid = Number(values['parent-pid'] || 0);
const waitMs = Number(values['wait-minutes']) * 60_000;
const maxHoldMs = Number(values['max-hold-minutes']) * 60_000;

/** @param {string} line */
const log = (line) => process.stderr.write(`[lock] ${line}\n`);

const resource = 'https://storage.azure.com/';
const token = cachedToken(githubFederatedToken(resource) ?? azCliToken(resource, { subscription: values.subscription || undefined }));

// Ctrl+C reaches every process in the terminal's group; the orchestrator decides what it means.
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});

/** @type {import('./lib/lock.mjs').Lock | null} */
let lock = null;
let stopping = false;

/** @param {number} code @param {boolean} release */
async function stop(code, release) {
  if (stopping) return;
  stopping = true;
  if (lock && release) {
    await lock.release();
    log('released the lock');
  }
  process.exit(code);
}

process.on('SIGUSR1', () => void stop(0, true));
// Waiting for the lock, these have nothing to leave behind; they end the wait the same way.
process.on('SIGUSR2', () => void stop(0, false));
process.on('SIGTERM', () => void stop(0, false));

let heldSince = 0;
// From the start: an orchestrator that dies while this waits must not leave it to take the lock.
setInterval(() => {
  if (parentPid) {
    try {
      process.kill(parentPid, 0);
    } catch {
      log('the run that asked for the lock is gone; no longer renewing it (it lapses within 60 s unless the test job renews it)');
      void stop(5, false);
      return;
    }
  }
  if (heldSince && Date.now() - heldSince > maxHoldMs) {
    log(`error: held the lock for ${values['max-hold-minutes']} minutes, longer than any run; releasing it`);
    void stop(4, true);
  }
}, 5000).unref();

try {
  lock = await acquireLock(blobUrl, token, {
    waitMs,
    log,
    holder: { runId: values['run-id'], gitSha: values['git-sha'] },
    onLost: () => void stop(3, false),
  });
} catch (err) {
  log(`error: ${/** @type {Error} */ (err).message}`);
  process.exit(2);
}
const tmp = `${leaseFile}.tmp`;
writeFileSync(tmp, lock.leaseId, { mode: 0o600 });
renameSync(tmp, leaseFile);
log('holding the lock; no other run can deploy to dev or start the tests until this one ends');

heldSince = Date.now();
// Keeps the process alive while the lease is renewed (the renewal timer does not).
setInterval(() => {}, 60_000);
