import { expect, postProject, signInAgain, test, uid, type Principal } from './fixtures';

// Google and ORCID accounts, as the API sees them. The emulator signs a browser in as any principal,
// so these run without either provider: what matters here is what the API does with the principal
// Static Web Apps hands it. Whether the providers themselves are reachable is up to the build
// (web/src/lib/signin.ts, tested in web/test/seo.test.ts); this build offers neither.

test('an ORCID account is its own account, even with the same id as a GitHub one', async ({ person, signedOut }) => {
  const github = await person({ role: 'researcher' });
  const project = await postProject(github);

  // The same userId from ORCID. Static Web Apps documents ids as unique per site, so this should
  // never happen; if it did, it must not reach the GitHub account.
  const orcid: Principal = { ...github.principal, identityProvider: 'orcid', userDetails: 'Josiah Carberry' };
  const visitor = await signedOut();
  await signInAgain(visitor.context, orcid);
  const me = await (await visitor.request.get('/api/me')).json();
  expect(me.principal.provider).toBe('orcid');
  expect(me.user).toMatchObject({ id: `orcid:${github.principal.userId}`, provider: 'orcid', displayName: 'Josiah Carberry', hasAtlasEmail: false });
  expect((await visitor.request.patch(`/api/projects/${project.id}`, { data: { title: 'Taken over' } })).status()).toBe(403);
  const mine = await (await visitor.request.get('/api/my')).json();
  expect(mine.projects).toEqual([]);

  // The GitHub account is untouched.
  const still = await (await github.request.get('/api/me')).json();
  expect(still.user).toMatchObject({ id: github.principal.userId, provider: 'github', displayName: github.name });

  await visitor.page.goto('/profile');
  await expect(visitor.page.getByText('Signed in with ORCID as Josiah Carberry')).toBeVisible();
});

test('an ORCID account with no public name starts with a placeholder, never the iD', async ({ signedOut }) => {
  const visitor = await signedOut();
  const id = `e2e${uid()}`;
  await signInAgain(visitor.context, { identityProvider: 'orcid', userId: id, userDetails: '0000-0002-1825-0097', userRoles: ['anonymous', 'authenticated'], claims: [] });
  const me = await (await visitor.request.get('/api/me')).json();
  expect(me.user.displayName).toBe(`user-${id.slice(0, 6)}`);
});

test('a Google account posts and pledges like any other, and shows as Google', async ({ person }) => {
  const researcher = await person({ role: 'researcher', provider: 'google' });
  expect(researcher.id).toBe(`google:${researcher.principal.userId}`);
  const project = await postProject(researcher);
  const donor = await person({ role: 'donor', provider: 'orcid' });
  expect((await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 10, method: 'manual' } })).status()).toBe(201);
  await donor.page.goto(`/projects/${project.id}`);
  await expect(donor.page.getByText(`${researcher.name} (signed in with Google)`)).toBeVisible();
});

test('a principal from a provider the site does not offer is not signed in', async ({ signedOut }) => {
  const visitor = await signedOut();
  for (const provider of ['facebook', 'twitter', 'apple']) {
    await signInAgain(visitor.context, { identityProvider: provider as Principal['identityProvider'], userId: `e2e${uid()}`, userDetails: 'x', userRoles: ['anonymous', 'authenticated'], claims: [] });
    expect((await visitor.request.get('/api/me')).status(), provider).toBe(401);
  }
});
