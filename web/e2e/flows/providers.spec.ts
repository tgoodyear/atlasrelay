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

test('a new Google account takes the name from the sign-in, and the dashboard says so once', async ({ signedOut }) => {
  const visitor = await signedOut();
  const id = `e2e${uid()}`;
  await signInAgain(visitor.context, {
    identityProvider: 'google', userId: id, userDetails: `${id}@gmail.com`, userRoles: ['anonymous', 'authenticated'],
    claims: [{ typ: 'name', val: 'Ada Lovelace' }, { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', val: `${id}@gmail.com` }],
  });
  await visitor.page.goto('/dashboard');
  const prompt = visitor.page.getByRole('status').filter({ hasText: "This is how you'll appear on projects and pledges" });
  await expect(prompt).toContainText('Ada Lovelace');
  await expect(prompt.getByRole('link', { name: 'change' })).toHaveAttribute('href', '/profile');
  expect((await (await visitor.request.get('/api/me')).json()).user.displayName).toBe('Ada Lovelace');
  await prompt.getByRole('button', { name: 'Dismiss' }).click();
  await expect(prompt).toHaveCount(0);
  // Saved once: another visit neither changes the name nor shows the prompt again.
  await visitor.page.reload();
  await expect(visitor.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(visitor.page.getByText("This is how you'll appear")).toHaveCount(0);
});

test('the dashboard stops offering the sign-in name once the profile changes it', async ({ signedOut }) => {
  const visitor = await signedOut();
  const id = `e2e${uid()}`;
  await signInAgain(visitor.context, {
    identityProvider: 'google', userId: id, userDetails: `${id}@gmail.com`, userRoles: ['anonymous', 'authenticated'],
    claims: [{ typ: 'name', val: 'Ada Lovelace' }],
  });
  await visitor.page.goto('/dashboard');
  const prompt = visitor.page.getByRole('status').filter({ hasText: "This is how you'll appear on projects and pledges" });
  await expect(prompt).toContainText('Ada Lovelace');
  // Followed within the app, so the notice's state is still there when the dashboard comes back.
  await prompt.getByRole('link', { name: 'change' }).click();
  await visitor.page.getByLabel('Display name').fill('Augusta King');
  await visitor.page.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(async () => (await (await visitor.request.get('/api/me')).json()).user.displayName).toBe('Augusta King');
  await visitor.page.getByRole('link', { name: 'Dashboard' }).first().click();
  await expect(visitor.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(visitor.page.getByText("This is how you'll appear")).toHaveCount(0);
});

test('a Google account with no name claim keeps the placeholder', async ({ signedOut }) => {
  const visitor = await signedOut();
  const id = `e2e${uid()}`;
  await signInAgain(visitor.context, { identityProvider: 'google', userId: id, userDetails: `${id}@gmail.com`, userRoles: ['anonymous', 'authenticated'], claims: [] });
  await visitor.page.goto('/dashboard');
  await expect(visitor.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const me = (await (await visitor.request.get('/api/me')).json()).user;
  expect(me.displayName).toBe(`user-${id.slice(0, 6)}`);
  await expect(visitor.page.getByText("This is how you'll appear")).toHaveCount(0);
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

test('a build without its own registrations answers 404 for Google and ORCID sign-in', async ({ signedOut }) => {
  const visitor = await signedOut();
  // Static Web Apps matches routes without regard to case; the emulator does not, so only the
  // lower-case forms are checked here.
  for (const path of ['/.auth/login/google', '/.auth/login/orcid', '/login/google', '/login/orcid']) {
    expect((await visitor.request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
  }
});

for (const provider of ['google', 'orcid'] as const) {
  test(`a ${provider === 'google' ? 'Google' : 'ORCID'} donor sees the actions on their own pending pledge`, async ({ person }) => {
    const researcher = await person({ role: 'researcher' });
    const project = await postProject(researcher);
    const donor = await person({ role: 'donor', provider });
    const res = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 10, method: 'manual' } });
    expect(res.status()).toBe(201);
    await donor.page.goto(`/projects/${project.id}`);
    await expect(donor.page.getByRole('button', { name: "I've sent the credits" })).toBeVisible();
    await expect(donor.page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await donor.page.getByRole('button', { name: "I've sent the credits" }).click();
    await expect(donor.page.getByRole('button', { name: "I've sent the credits" })).toHaveCount(0);
  });
}
