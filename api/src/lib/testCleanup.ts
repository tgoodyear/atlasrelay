import { HttpRequest } from '@azure/functions';
import { getPrincipal } from './auth';
import { HttpError } from './http';
import { isId } from './ids';
import type { Pledge, Project } from './store';
import { pledgeRequestRunning } from './store';

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
  closeProject(id: string): Promise<void>;
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
 * 4. The project is closed, so no new pledge starts, and then no pledge request may still be
 *    running: none mid-transfer, and no recently taken slot without its pledge row. A request
 *    that read the project before it closed and writes after this check can still leave a row
 *    behind; the second sweep in deleteProjectRecords narrows that, it does not close it. This is
 *    a test environment's cleanup, called after the tests finish, not a general delete.
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
  if (!project) throw new HttpError(404, 'Not found');
  if (project.ownerId !== principal.userId) throw new HttpError(403, 'Only the project owner can delete it');
  if (project.createdByTests !== true) throw new HttpError(403, 'Only projects the tests posted can be deleted');
  if (project.status !== 'closed') await store.closeProject(id);
  const [pledges, slots] = await Promise.all([store.listPledges(id), store.listPledgeSlots(id)]);
  if (pledgeRequestRunning(slots, pledges)) {
    throw new HttpError(409, 'A pledge to this project is still in progress. Try again in a few minutes.');
  }
  const removed = await store.deleteProjectRecords(project);
  return { deleted: id, ...removed };
}
