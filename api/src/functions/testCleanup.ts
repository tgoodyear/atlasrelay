import { app, HttpFunctionOptions, HttpRequest } from '@azure/functions';
import { handle, json } from '../lib/http';
import { deleteProjectRecords, getProject, listPledgeSlots, listPledges, patchProject } from '../lib/store';
import { TEST_CLEANUP_ROUTE, deleteTestProject, testCleanupEnabled } from '../lib/testCleanup';
import { logEvent } from '../lib/telemetry';

type Register = (name: string, options: HttpFunctionOptions) => void;

/**
 * Register the test cleanup route, only when the environment allows it. On prod the setting is
 * absent and the function does not exist at all; the handler's own check is the second line. App
 * settings are read when the worker starts, and changing one restarts it, so this is decided again
 * on every change.
 */
export function registerTestCleanup(
  env: Record<string, string | undefined> = process.env,
  register: Register = (name, options) => app.http(name, options),
): boolean {
  if (!testCleanupEnabled(env)) return false;
  register('test-project-delete', {
    route: TEST_CLEANUP_ROUTE,
    methods: ['DELETE'],
    authLevel: 'anonymous',
    handler: handle(async (req: HttpRequest) => {
      const result = await deleteTestProject(req, {
        getProject,
        listPledges,
        listPledgeSlots,
        closeProject: async (id) => { await patchProject(id, { status: 'closed' }); },
        deleteProjectRecords,
      });
      logEvent('test-cleanup', { projectId: result.deleted, pledges: result.pledges, claims: result.claims });
      return json(result);
    }),
  });
  return true;
}

registerTestCleanup();
