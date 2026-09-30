import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, postProject, test } from './fixtures';

// axe-core on the main pages, signed out and signed in, against WCAG 2.1 A and AA.

async function checkPage(page: Page, label: string): Promise<void> {
  // Wait for the app to finish loading what the page shows before scanning it.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.spinner')).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`);
  expect(summary, `${label}\n${summary.join('\n')}`).toEqual([]);
}

test('signed-out pages have no axe violations', async ({ signedOut, person }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  const { page } = await signedOut();
  for (const path of ['/', '/projects', `/projects/${project.id}`, '/how-it-works', '/privacy', '/dashboard', '/no-such-page']) {
    await page.goto(path);
    await checkPage(page, path);
  }
});

test('signed-in pages and the pledge dialog have no axe violations', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher);
  // One confirmed pledge and one pending, so the page shows both kinds of status pill.
  const pledged = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 10, method: 'manual' } });
  expect(pledged.status()).toBe(201);
  const pledgeId = (await pledged.json()).pledge.id as string;
  expect((await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'confirmed' } })).status()).toBe(200);
  const second = await person({ role: 'donor' });
  expect((await second.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 10, method: 'manual' } })).status()).toBe(201);

  const { page } = researcher;
  for (const path of ['/dashboard', '/profile', '/projects/new', `/projects/${project.id}`, `/projects/${project.id}/edit`]) {
    await page.goto(path);
    await checkPage(page, `${path} as owner`);
  }

  const other = await person({ role: 'other' });
  await other.page.goto(`/projects/${project.id}`);
  await other.page.getByRole('button', { name: 'Send credits' }).click();
  await expect(other.page.getByRole('dialog')).toBeVisible();
  await checkPage(other.page, 'pledge dialog');
});
