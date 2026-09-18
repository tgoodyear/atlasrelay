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
    const closeOpen = async (): Promise<number> => {
      const open = (await listProjectsByOwner(p.userId)).filter((x) => x.status === 'open');
      for (const project of open) {
        await patchProject(project.id, { status: 'closed' });
      }
      return open.length;
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
    try {
      closed = await closeOpen();
    } catch (err) {
      console.error('Profile deleted but its projects could not all be closed:', err instanceof Error ? err.message : err);
    }
    return json({ deleted: true, projectsClosed: closed });

  }),
});
