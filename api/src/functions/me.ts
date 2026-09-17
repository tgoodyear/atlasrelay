import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json, readJson } from '../lib/http';
import { ensureUser, updateUser } from '../lib/store';
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
