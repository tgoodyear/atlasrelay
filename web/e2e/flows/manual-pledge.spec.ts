import { fmtCompact } from '../../src/lib/api';
import { expect, postProject, test } from './fixtures';

// A donor pledges to transfer by hand on atlas.ripe.net: the site shows them where to send the
// credits, the donor marks the pledge sent, and the researcher confirms it arrived.

interface Stats {
  creditsTransferred: number;
  fundedProjects: number;
}

test('manual pledge: pledged, sent, confirmed, and the totals follow', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 700 });

  // Other tests change the site-wide figures at the same time, so they are compared as at least.
  const statsBefore = ((await (await donor.request.get('/api/stats')).json()) as { stats: Stats }).stats;

  const { page } = donor;
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: 'Send credits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send credits' });
  await expect(dialog.getByLabel('Amount')).toHaveValue('700');
  await dialog.getByRole('radio', { name: /I'll transfer on atlas.ripe.net myself/ }).check();
  await expect(dialog.getByLabel('RIPE Atlas API key')).toHaveCount(0);
  await dialog.getByLabel('Message (optional, public)').fill('Good luck with the study');
  await dialog.getByRole('button', { name: 'Create pledge' }).click();

  const done = page.getByRole('dialog', { name: 'Finish the transfer on atlas.ripe.net' });
  await expect(done.getByText('Pledge recorded. Now make the transfer on RIPE Atlas.')).toBeVisible();
  await expect(done.locator('.copy-box')).toContainText(researcher.email);
  await expect(done.getByRole('link', { name: 'atlas.ripe.net/credits/transfer' })).toHaveAttribute('href', 'https://atlas.ripe.net/credits/transfer/');
  await expect(done.getByText('700', { exact: true })).toBeVisible();
  await done.getByRole('button', { name: 'Done' }).click();

  const pledge = page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge.getByText('Pledged', { exact: true })).toBeVisible();
  await expect(pledge.getByText('Good luck with the study')).toBeVisible();
  await expect(page.locator('dl.kv')).toContainText('Pending700');

  // The public sees the pledge and the name, and never the researcher's address.
  const visitor = await signedOut();
  await visitor.page.goto(`/projects/${project.id}`);
  await expect(visitor.page.locator('.pledge').filter({ hasText: donor.name })).toContainText('Pledged');
  await expect(visitor.page.locator('body')).not.toContainText(researcher.email);

  await pledge.getByRole('button', { name: "I've sent the credits" }).click();
  await expect(pledge.getByText('Sent, awaiting confirmation')).toBeVisible();

  // The donor's dashboard lists it.
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'My pledges (1)' }).click();
  const dashRow = page.getByRole('row').filter({ hasText: project.title });
  await expect(dashRow).toContainText('Manual');
  await expect(dashRow).toContainText('Sent, awaiting confirmation');

  // The researcher sees the pending pledge from their dashboard, and confirms it.
  const owner = researcher.page;
  await owner.goto('/dashboard');
  await expect(owner.getByText('1 of your projects has pending pledges.')).toBeVisible();
  await owner.getByRole('link', { name: 'Review pledges' }).click();
  const ownerRow = owner.locator('.pledge').filter({ hasText: donor.name });
  await ownerRow.getByRole('button', { name: 'Confirm received' }).click();
  await expect(ownerRow.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(owner.locator('dl.kv')).toContainText('Received700');
  await expect(owner.locator('dl.kv')).toContainText('Pending0');
  await expect(owner.locator('.pill-green', { hasText: 'Funded' })).toBeVisible();
  // Funded, so the results section appears, empty, with a prompt for the owner.
  await expect(owner.getByRole('heading', { name: 'Results' })).toBeVisible();
  await expect(owner.getByText('No results posted yet.')).toBeVisible();

  // The donor's view catches up, with nothing left to act on.
  await page.goto(`/projects/${project.id}`);
  await expect(pledge.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(pledge.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('This project is not accepting more credits.')).toHaveCount(0);

  // The home page figures moved. A fresh visitor, because the browser caches /api/stats.
  const home = await signedOut();
  const statsResponse = home.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/stats');
  await home.page.goto('/');
  const stats = ((await (await statsResponse).json()) as { stats: Stats }).stats;
  expect(stats.creditsTransferred).toBeGreaterThanOrEqual(statsBefore.creditsTransferred + 700);
  expect(stats.fundedProjects).toBeGreaterThanOrEqual(statsBefore.fundedProjects + 1);
  const tile = home.page.locator('.stat-tile').filter({ hasText: 'credits transferred so far' });
  await expect(tile.locator('.value')).toHaveText(fmtCompact(stats.creditsTransferred));

  // The listing shows it under Funded.
  await home.page.goto(`/projects?status=funded&q=${encodeURIComponent(project.title)}`);
  await expect(home.page.getByRole('link', { name: project.title })).toBeVisible();

});

test('a donor can cancel a manual pledge, and cannot hold two at once', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 400 });

  const first = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 100, method: 'manual' } });
  expect(first.status()).toBe(201);
  const second = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 100, method: 'manual' } });
  expect(second.status()).toBe(409);
  expect((await second.json()).error.message).toContain('You already have a pledge in progress');

  // The owner cannot pledge to their own project.
  const own = await researcher.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 100, method: 'manual' } });
  expect(own.status()).toBe(403);

  const { page } = donor;
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/projects/${project.id}`);
  const pledge = page.locator('.pledge').filter({ hasText: donor.name });
  await pledge.getByRole('button', { name: 'Cancel' }).click();
  await expect(pledge.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.locator('dl.kv')).toContainText('Pending0');

  // The slot is free again.
  const again = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 100, method: 'manual' } });
  expect(again.status()).toBe(201);
});
