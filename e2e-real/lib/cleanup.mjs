// Removes the projects one run posted, through the test-only route DELETE /api/test/projects/{id}
// (api/src/lib/testCleanup.ts). That route exists only on an environment with
// E2E_PROJECT_CLEANUP=1, which Bicep sets everywhere except prod. site.ts supplies the requests,
// signed in as the researcher, who owns every project a run posts.
//
// A run's projects are found by title, not by remembering ids as they are posted: a test that
// fails between posting a project and reading its address has still posted it. Every spec titles
// its projects "E2E <what> <run>", so the researcher's own list, filtered on that, is exactly what
// this run left. The output names project ids only. Calling it again once everything is gone deletes
// nothing and passes, which is what lets a spec call it from afterAll as well as afterEach.

/** The title prefix the API marks test projects by (TEST_TITLE_PREFIX in api/src/lib/testCleanup.ts). */
export const TEST_TITLE_PREFIX = 'E2E ';

/**
 * The projects in `projects` that this run posted.
 * @template {{ id: string, title: string }} P
 * @param {P[]} projects
 * @param {string} run
 * @returns {P[]}
 */
export function runProjects(projects, run) {
  if (!run) throw new Error('No run id to find the run\'s projects by');
  return projects.filter((p) => p.title.startsWith(TEST_TITLE_PREFIX) && p.title.endsWith(` ${run}`));
}

/**
 * @typedef {object} CleanupIo
 * @property {() => Promise<{ id: string, title: string }[]>} list the researcher's projects (GET /api/my)
 * @property {(id: string) => Promise<number>} remove DELETE /api/test/projects/{id}; the HTTP status
 * @property {(id: string) => Promise<number>} read GET /api/projects/{id} as the researcher; the HTTP status
 * @property {(line: string) => void} log
 * @property {(ms: number) => Promise<void>} [wait] defaults to a timer; tests pass their own
 */

/**
 * The first DELETE closes the project and answers 409; the API deletes it only once it has been
 * closed for longer than any pledge request runs, two minutes (CLAIM_ORPHAN_GRACE_MS in
 * api/src/lib/store.ts). It also answers 409 while a transfer is in flight, which lasts as long at
 * most. So a 409 is retried for three minutes.
 */
export const WAIT_RETRIES = 12;
export const WAIT_MS = 15_000;
export const SERVER_ERROR_RETRIES = 3;
export const SERVER_ERROR_WAIT_MS = 5_000;

/**
 * Delete every project this run posted. Tries them all, then throws if any is left, so a run that
 * could not clean up fails and says which ids remain.
 *
 * With `wait: false` it makes one request per project and does not wait out a 409: that starts the
 * API's two-minute wait for each project (or deletes one whose wait is over), so a spec can start it
 * after each test and wait once, after the last.
 * @param {CleanupIo} io
 * @param {string} run
 * @param {{ wait?: boolean }} [options]
 * @returns {Promise<string[]>} the ids deleted
 */
export async function deleteRunProjects(io, run, { wait: waitOut = true } = {}) {
  const mine = runProjects(await io.list(), run);
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const left = [];
  const wait = io.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (const { id } of mine) {
    let status = await io.remove(id);
    let started = false;
    // One loop, with a budget for each kind of answer, so the two can come in any order. A 409 is the
    // API's wait; a server error can leave a cleanup part done, which the API finishes on the next
    // call, even once the project row is gone.
    let waits = 0;
    let errors = 0;
    for (;;) {
      if (status === 409 && !started) {
        started = true;
        io.log(`[cleanup] project ${id} is closed; deleting it once no pledge to it can still be running`);
      }
      // Without waiting, a 409 at any point means the close has started, which is all that is asked.
      if (status === 409 && !waitOut) break;
      if (!((status === 409 && waits < WAIT_RETRIES) || (status >= 500 && errors < SERVER_ERROR_RETRIES))) break;
      if (status === 409) {
        waits += 1;
        await wait(WAIT_MS);
      } else {
        errors += 1;
        await wait(SERVER_ERROR_WAIT_MS);
      }
      status = await io.remove(id);
    }
    if (status === 409 && !waitOut) continue;
    if (status === 200) {
      deleted.push(id);
      continue;
    }
    if (status !== 404) {
      left.push(`${id} (HTTP ${status})`);
      continue;
    }
    // 404 is either a project already gone or an environment without the route; only a read tells,
    // and only its own 404 means gone.
    const read = await io.read(id);
    if (read === 404) continue;
    left.push(read === 200
      ? `${id} (HTTP 404: this environment has no cleanup route; provision it so E2E_PROJECT_CLEANUP is set)`
      : `${id} (HTTP 404, then HTTP ${read} reading it back)`);
  }
  io.log(`[cleanup] deleted ${deleted.length} project(s)${deleted.length ? `: ${deleted.join(', ')}` : ''}`);
  if (left.length) throw new Error(`[cleanup] ${left.length} project(s) not deleted: ${left.join('; ')}`);
  return deleted;
}
