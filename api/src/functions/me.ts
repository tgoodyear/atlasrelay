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
    // Close any open project first. Pledging to a project whose owner is gone cannot work: the
    // handler needs the owner's RIPE address to name a recipient. Leaving them open would
    // advertise projects that fail at the moment a donor tries to give to them.
    const closeOpen = async (): Promise<number> => {
      const open = (await listProjectsByOwner(p.userId)).filter((x) => x.status === 'open');
      for (const project of open) {
        await patchProject(project.id, { status: 'closed' });
      }
      return open.length;
    };

    // Close, delete, then close again. Listing and closing is not atomic with project creation, so
    // a request that validated the profile a moment earlier can create or reopen a project between
    // the two, which would leave exactly what this is meant to prevent: an open project whose owner
    // has no address to receive credits. The second pass catches anything that landed in that
    // window, and creating one after the user row is gone is already refused, because both posting
    // and reopening require a profile with a RIPE address.
    const closed = await closeOpen();
    await deleteUser(p.userId);
    const late = await closeOpen();
    return json({ deleted: true, projectsClosed: closed + late });

  }),
});
