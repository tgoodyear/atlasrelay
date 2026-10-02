import { HttpRequest } from '@azure/functions';
import { getPrincipal } from './auth';
import { HttpError } from './http';
import { isId } from './ids';
import type { Pledge, Project } from './store';
import { CLAIM_ORPHAN_GRACE_MS, pledgeRequestRunning } from './store';

/**
 * Deleting the projects the full-flow tests post, on a test environment only.
 *
 * The site has no way to delete a project, so every test run on dev used to leave a funded project
 * with results behind, and the home-page figures counted them. This route removes what a run
 * posted. It exists only where E2E_PROJECT_CLEANUP is '1', which Bicep sets on the Function App of
 * every environment except prod (infra/api.bicep, infra/main.bicep). Without it the route is never
 * registered, and the handler answers 404 as well, before reading the request, so a prod app
 * cannot tell anyone the route exists.
 *
 * Three conditions, all required: the environment allows it, the caller owns the project, and the
 * project was marked as a test project when it was created. See SECURITY.md.
 */
export const TEST_CLEANUP_SETTING = 'E2E_PROJECT_CLEANUP';

/** Where the route lives, under /api. Kept away from projects/{id} so it never looks like a product feature. */
export const TEST_CLEANUP_ROUTE = 'test/projects/{id}';

/**
 * The title prefix the full-flow tests give every project they post. On a test environment a
 * project created with a title starting with this carries the stored marker; nowhere else does.
 */
export const TEST_TITLE_PREFIX = 'E2E ';

/** Exactly '1'. Anything else, including an absent setting, is off. */
export function testCleanupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TEST_CLEANUP_SETTING] === '1';
}

/**
 * Whether a project being created gets the test marker. Decided once, at creation, and stored: no
 * edit can add it later, because the update path never writes the field. On prod the setting is
 * absent, so no prod project ever carries it.
 */
export function marksTestProject(title: string, env: Record<string, string | undefined> = process.env): boolean {
  return testCleanupEnabled(env) && title.startsWith(TEST_TITLE_PREFIX);
}

/** The storage calls the handler makes, passed in so the rules can be tested without storage. */
export interface TestCleanupStore {
  getProject(id: string): Promise<Project | null>;
  listPledges(projectId: string): Promise<Pledge[]>;
  listPledgeSlots(projectId: string): Promise<{ donorId: string; pledgeId: string; createdAt: string }[]>;
  /** Close the project and stamp deletingSince, in one merge. */
  beginDeletion(id: string, at: string): Promise<void>;
  /**
   * A conditional write on the version just read, keeping the project closed. Rejects (412) when the
   * project changed since, so nothing that happened after the checks below can be deleted under.
   */
  fence(id: string, etag: string): Promise<void>;
  /** The owner recorded when a cleanup started and has not finished (store.getCleanupTombstone). */
  getCleanupTombstone(id: string): Promise<{ ownerId: string } | null>;
  deleteProjectRecords(project: Pick<Project, 'id' | 'ownerId'>): Promise<{ pledges: number; claims: number }>;
}

export interface TestCleanupResult {
  deleted: string;
  pledges: number;
  claims: number;
}

/**
 * DELETE /api/test/projects/{id}. The order of the checks is the point:
 *
 * 1. The setting, before anything else is read, so a disabled app answers exactly as it does for a
 *    route that does not exist.
 * 2. A signed-in caller, then the project's owner: only the account that posted it.
 * 3. The stored marker: only a project posted by the tests, never a project its owner wrote by hand.
 * 4. Two calls, at least CLAIM_ORPHAN_GRACE_MS apart. The first closes the project and stamps
 *    deletingSince, and answers 409. A pledge request reads the project, sees it open and goes on
 *    to take a slot, write its row and transfer; every one that read it before the close has
 *    finished within the grace, which is the bound the pledge slots and the confirmation lock
 *    already rely on (a RIPE call gives up after 20 seconds). Every one that reads it after the
 *    close is refused as closed. So once the stamp is older than the grace, no pledge request is
 *    left that could write to the project, and the second call deletes. The stamp stands for an
 *    unbroken closed period because the edit path refuses to reopen a project that carries it, and
 *    a reopen that slipped in anyway (one that read the project before the stamp) leaves it open,
 *    which starts the wait again. The pledge rows are checked as well, and the deletion goes ahead
 *    only after a conditional write on the version all of this was decided on.
 *
 * A tombstone written before anything is deleted lets the owner finish a cleanup that failed part way,
 * even after the project row went.
 */
export async function deleteTestProject(
  req: HttpRequest,
  store: TestCleanupStore,
  env: Record<string, string | undefined> = process.env,
): Promise<TestCleanupResult> {
  if (!testCleanupEnabled(env)) throw new HttpError(404, 'Not found');
  const principal = getPrincipal(req, env);
  if (!principal) throw new HttpError(401, 'Sign in required');
  const id = req.params.id;
  if (!isId(id)) throw new HttpError(404, 'Not found');
  const project = await store.getProject(id);
  if (!project) {
    // A cleanup that failed after the project row went is finished by its owner calling again. The
    // tombstone is written only by a cleanup that had passed every check below.
    const tombstone = await store.getCleanupTombstone(id);
    if (!tombstone || tombstone.ownerId !== principal.userId) throw new HttpError(404, 'Not found');
    const removed = await store.deleteProjectRecords({ id, ownerId: tombstone.ownerId });
    return { deleted: id, ...removed };
  }
  if (project.ownerId !== principal.userId) throw new HttpError(403, 'Only the project owner can delete it');
  if (project.createdByTests !== true) throw new HttpError(403, 'Only projects the tests posted can be deleted');
  const now = Date.now();
  const since = Date.parse(project.deletingSince ?? '');
  if (project.status !== 'closed' || !Number.isFinite(since)) {
    await store.beginDeletion(id, new Date(now).toISOString());
    throw new HttpError(409, `The project is closed and will be deleted once any pledge in progress has finished. Try again in ${CLAIM_ORPHAN_GRACE_MS / 1000} seconds.`);
  }
  if (now - since <= CLAIM_ORPHAN_GRACE_MS) {
    throw new HttpError(409, `The project was closed for deletion less than ${CLAIM_ORPHAN_GRACE_MS / 1000} seconds ago. Try again shortly.`);
  }
  const [pledges, slots] = await Promise.all([store.listPledges(id), store.listPledgeSlots(id)]);
  if (pledgeRequestRunning(slots, pledges)) {
    throw new HttpError(409, 'A pledge to this project is still in progress. Try again in a few minutes.');
  }
  // Everything above was decided on the version read at the top. A reopen or any other write since
  // then means the decision may no longer hold, so the next call decides again.
  if (!project.etag) throw new HttpError(409, 'The project could not be checked. Try again.');
  try {
    await store.fence(id, project.etag);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 412) {
      throw new HttpError(409, 'The project changed while it was being deleted. Try again.');
    }
    throw err;
  }
  const removed = await store.deleteProjectRecords(project);
  return { deleted: id, ...removed };
}
