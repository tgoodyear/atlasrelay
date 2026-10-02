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
 * The API refuses (409) while a pledge's transfer is in flight, which lasts two minutes at most
 * (CLAIM_ORPHAN_GRACE_MS in api/src/lib/store.ts). A test that timed out mid-transfer leaves one, so
 * a 409 is retried for a little longer than that.
 */
export const IN_FLIGHT_RETRIES = 10;
export const IN_FLIGHT_WAIT_MS = 15_000;

/**
 * Delete every project this run posted. Tries them all, then throws if any is left, so a run that
 * could not clean up fails and says which ids remain.
 * @param {CleanupIo} io
 * @param {string} run
 * @returns {Promise<string[]>} the ids deleted
 */
export async function deleteRunProjects(io, run) {
  const mine = runProjects(await io.list(), run);
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const left = [];
  const wait = io.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (const { id } of mine) {
    let status = await io.remove(id);
    for (let i = 0; status === 409 && i < IN_FLIGHT_RETRIES; i++) {
      io.log(`[cleanup] project ${id} has a transfer in flight; trying again in ${IN_FLIGHT_WAIT_MS / 1000} s`);
      await wait(IN_FLIGHT_WAIT_MS);
      status = await io.remove(id);
    }
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
