import { anonymous, expect, postProject, recordResponses, test } from './fixtures';

// Who can see what: an anonymous pledge's name, and the researcher's RIPE NCC Access email.

test('an anonymous pledge shows as Anonymous to everyone but the donor and the owner', async ({ person, browser }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher);

  const { page } = donor;
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: 'Send credits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send credits' });
  await dialog.getByRole('radio', { name: /I'll transfer on atlas.ripe.net myself/ }).check();
  await dialog.getByLabel('Amount').fill('120');
  await dialog.getByRole('checkbox', { name: 'Do not show my name on this project' }).check();
  await dialog.getByRole('button', { name: 'Create pledge' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

  // The donor sees their own name, marked as hidden from everyone else.
  const own = page.locator('.pledge').filter({ hasText: '120 credits' });
  await expect(own).toContainText(donor.name);
  await expect(own).toContainText('not shown publicly');

  // So does the owner.
  await researcher.page.goto(`/projects/${project.id}`);
  const ownerView = researcher.page.locator('.pledge').filter({ hasText: '120 credits' });
  await expect(ownerView).toContainText(donor.name);
  await expect(ownerView).toContainText('not shown publicly');

  // Everybody else sees Anonymous, on the page and in the API.
  const visitor = await anonymous(browser);
  const seen = recordResponses(visitor.page);
  await visitor.page.goto(`/projects/${project.id}`);
  const publicView = visitor.page.locator('.pledge').filter({ hasText: '120 credits' });
  await expect(publicView.locator('strong')).toHaveText('Anonymous');
  await expect(visitor.page.locator('body')).not.toContainText(donor.name);
  for (const body of await seen()) expect(body, body.split('\n')[0]).not.toContain(donor.name);

  const other = await person({ role: 'other' });
  await other.page.goto(`/projects/${project.id}`);
  await expect(other.page.locator('.pledge').filter({ hasText: '120 credits' }).locator('strong')).toHaveText('Anonymous');
  await expect(other.page.locator('body')).not.toContainText(donor.name);
  await visitor.context.close();
});

test('the RIPE NCC Access email reaches only a donor who starts a pledge', async ({ person, browser }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  const email = researcher.email;

  // Anonymous visitor: pages, listing, sitemap, project page head and every API response.
  const visitor = await anonymous(browser);
  const anonSeen = recordResponses(visitor.page);
  for (const path of ['/', '/projects', `/projects/${project.id}`]) {
    await visitor.page.goto(path);
    await expect(visitor.page.locator('main')).not.toBeEmpty();
    await visitor.page.waitForLoadState('networkidle');
    await expect(visitor.page.locator('body')).not.toContainText(email);
  }
  for (const body of await anonSeen()) expect(body, body.split('\n')[0]).not.toContain(email);
  for (const path of ['/sitemap.xml', '/api/projects?status=all', `/api/projects/${project.id}`, '/api/stats', `/projects/${project.id}`]) {
    expect(await (await visitor.request.get(path)).text(), path).not.toContain(email);
  }

  // A signed-in user with no pledge: same, including the pledge list route, which shows them nothing.
  const other = await person({ role: 'other' });
  const otherSeen = recordResponses(other.page);
  await other.page.goto(`/projects/${project.id}`);
  await other.page.waitForLoadState('networkidle');
  await expect(other.page.locator('body')).not.toContainText(email);
  const pledges = await other.request.get(`/api/projects/${project.id}/pledges`);
  expect(await pledges.json()).toEqual({ pledges: [], isOwner: false });
  for (const body of await otherSeen()) expect(body, body.split('\n')[0]).not.toContain(email);
  // The balance route needs a signed-in user.
  expect((await visitor.request.post('/api/atlas/balance', { data: { apiKey: 'x' } })).status()).toBe(401);

  // A donor who starts a manual pledge is shown it, once, in the pledge response.
  const donor = await person({ role: 'donor' });
  const res = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 50, method: 'manual' } });
  expect(res.status()).toBe(201);
  const created = await res.json();
  expect(created.recipientEmail).toBe(email);
  expect(JSON.stringify(created.project)).not.toContain(email);
  expect(JSON.stringify(created.pledge)).not.toContain(email);
  expect(await (await donor.request.get(`/api/projects/${project.id}`)).text()).not.toContain(email);
  await visitor.context.close();
});
