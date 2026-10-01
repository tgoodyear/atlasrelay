import { acceptDialogs, allRows, expect, postProject, row, signInAgain, test, type Person } from './fixtures';

// "Delete my profile" removes the profile and the RIPE NCC Access email, closes the owner's open
// projects, and leaves projects and pledges in place under the name Anonymous (docs/ARCHITECTURE.md,
// Privacy; Profile.tsx says the same to the user).

async function deleteProfile(p: Person): Promise<string[]> {
  const dialogs = acceptDialogs(p.page);
  await p.page.goto('/profile');
  await p.page.getByRole('button', { name: 'Delete my profile' }).click();
  // Deleting signs the person out and lands on the home page.
  await expect(p.page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(p.page).toHaveURL(/localhost:\d+\/$/);
  expect(dialogs[0]).toBe('Delete your profile and remove your RIPE NCC Access email?');
  return dialogs;
}

test('deleting a profile removes it and its email, and anonymizes what stays', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 500 });

  const pledged = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 200, method: 'manual', message: 'From the donor' } });
  expect(pledged.status()).toBe(201);
  const pledgeId = (await pledged.json()).pledge.id as string;
  const confirmed = await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'confirmed' } });
  expect(confirmed.status()).toBe(200);

  // The donor goes first.
  await deleteProfile(donor);
  expect(await row('users', 'user', donor.id)).toBeNull();
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ donorName: 'Anonymous', amount: 200, status: 'confirmed' });

  const visitor = await signedOut();
  await visitor.page.goto(`/projects/${project.id}`);
  await expect(visitor.page.locator('.pledge').filter({ hasText: '200 credits' }).locator('strong')).toHaveText('Anonymous');
  await expect(visitor.page.locator('body')).not.toContainText(donor.name);

  // Then the researcher, whose project is still open.
  expect(await row('users', 'project-post', researcher.id)).not.toBeNull();
  await deleteProfile(researcher);
  expect(await row('users', 'user', researcher.id)).toBeNull();
  expect(await row('users', 'project-post', researcher.id)).toBeNull();
  expect(await row('projects', 'project', project.id)).toMatchObject({ status: 'closed', ownerName: 'Anonymous', title: project.title });

  // Neither person's name nor the researcher's address is stored anywhere any more.
  const stored = JSON.stringify(await allRows());
  for (const gone of [researcher.email, researcher.name, donor.email, donor.name]) expect(stored).not.toContain(gone);

  await visitor.page.goto(`/projects/${project.id}`);
  await expect(visitor.page.getByText('by Anonymous')).toBeVisible();
  await expect(visitor.page.locator('.pill-muted', { hasText: 'Closed' })).toBeVisible();
  await expect(visitor.page.getByText('This project is closed.')).toBeVisible();
  await expect(visitor.page.getByRole('link', { name: 'Sign in to send credits' })).toHaveCount(0);
  await expect(visitor.page.locator('.pledge').filter({ hasText: '200 credits' })).toContainText('Confirmed');

  // Nobody can pledge to it now.
  const late = await person({ role: 'late' });
  const refused = await late.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 10, method: 'manual' } });
  expect(refused.status()).toBe(409);

  // Signing in again with the same account starts an empty profile that is still linked to the project.
  await signInAgain(researcher.context, researcher.principal);
  const me = (await (await researcher.request.get('/api/me')).json()).user;
  expect(me).toMatchObject({ atlasEmail: '', hasAtlasEmail: false });
  const my = await (await researcher.request.get('/api/my')).json();
  expect(my.projects.map((p: { id: string }) => p.id)).toContain(project.id);
});
