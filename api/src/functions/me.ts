import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json, readJson } from '../lib/http';
import { deleteUser, ensureUser, listProjectsByOwner, patchProject, updateUser } from '../lib/store';
import { email, httpsUrl, str } from '../lib/validate';
import { privateUser } from '../lib/views';

app.http('me-get', {
  route: 'me',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const user = await ensureUser(p.userId, p.identityProvider, p.userDetails);
    return json({ user: privateUser(user), principal: { provider: p.identityProvider, roles: p.userRoles } });
  }),
});

app.http('me-put', {
  route: 'me',
  methods: ['PUT'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    await ensureUser(p.userId, p.identityProvider, p.userDetails);
    const body = await readJson(req);
    const patch: Record<string, string> = {};
    const displayName = str(body, 'displayName', { max: 80 });
    if (displayName !== undefined) patch.displayName = displayName || p.userDetails;
    const atlasEmail = email(body, 'atlasEmail');
    if (atlasEmail !== undefined) patch.atlasEmail = atlasEmail;
    const affiliation = str(body, 'affiliation', { max: 120 });
    if (affiliation !== undefined) patch.affiliation = affiliation;
    const url = httpsUrl(body, 'url');
    if (url !== undefined) patch.url = url;
    const user = await updateUser(p.userId, patch);
    return json({ user: privateUser(user) });
  }),
});

app.http('me-delete', {
  route: 'me',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    // Pledging to a project whose owner is gone cannot work: the handler needs the owner's RIPE
    // address to name a recipient. Leaving them open would advertise projects that fail at the
    // moment a donor tries to give to them.
    // One project that will not close must not stop the rest. Aborting the sweep left every later
    // project open and still returned success, against a page that promises they are all closed.
    const closeOpen = async (): Promise<{ closed: number; failed: number }> => {
      const open = (await listProjectsByOwner(p.userId)).filter((x) => x.status === 'open');
      let closed = 0;
      let failed = 0;
      for (const project of open) {
        try {
          await patchProject(project.id, { status: 'closed' });
          closed += 1;
        } catch (err) {
          failed += 1;
          console.error(`Could not close project ${project.id} while deleting its owner:`, err instanceof Error ? err.message : err);
        }
      }
      return { closed, failed };
    };

    // The profile goes first. Sweeping projects is unbounded serial work over a shared partition,
    // and letting it run ahead of the delete means a person with many projects could have the
    // request time out with their RIPE address still stored, against a page that promises deletion
    // outright. Removing the row first makes the promise unconditional; the sweep is cleanup.
    await deleteUser(p.userId);

    // Then close what they own. A project left briefly open cannot be pledged to, because the
    // handler needs the owner's address to name a recipient, so the window is a clean failure
    // rather than a disclosure. Projects written after this sweep close themselves: creation and
    // reopening both re-check for the owner after writing.
    let closed = 0;
    let failed = 0;
    try {
      ({ closed, failed } = await closeOpen());
    } catch (err) {
      console.error('Profile deleted but its projects could not be swept:', err instanceof Error ? err.message : err);
      failed = -1;
    }
    // The profile is gone either way, which is the promise that matters and the one the page
    // makes. Say so separately from whether every project got closed, rather than reporting a
    // clean result over a sweep that did not finish. A project left open cannot be pledged to,
    // and creation and reopening both re-check for the owner, so it fails cleanly rather than
    // taking credits nobody can receive.
    return json({
      deleted: true,
      projectsClosed: closed,
      projectsNotClosed: failed === -1 ? null : failed,
      sweepComplete: failed === 0,
    });

  }),
});
