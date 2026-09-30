import { randomBytes } from 'node:crypto';
import { request as playwrightRequest, test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { confirmReceived, markSent, pledgeByHand, pledgeRow, postProjectInForm, postResults, saveProfile } from '../../web/e2e/ui';
import { RESEARCHER_ATLAS_EMAIL, statePath, type Role } from '../accounts';

// The whole flow on a deployed site, as the two test accounts signed in with Microsoft
// (global-setup.ts), with the same page steps as the local full-flow tests (web/e2e/ui.ts): the
// researcher posts a project, the donor pledges to transfer by hand and says the credits are sent,
// the researcher confirms them and posts results. No credits move: a manual pledge only records
// what the donor says, and the researcher's RIPE NCC Access email is on a reserved domain.
//
// Both profiles are deleted before and after the run. Deleting a profile closes its open projects
// and shows its projects and pledges as Anonymous; the site has no way to delete a project, so
// each run leaves one closed, anonymous project behind on the environment.

const run = process.env.E2E_RUN_ID?.slice(-12) || randomBytes(4).toString('hex');
const names: Record<Role, string> = { researcher: `E2E researcher ${run}`, donor: `E2E donor ${run}` };
const title = `E2E full flow ${run}`;
const credits = 250;
const resultsSummary = `Results of full-flow test run ${run}.`;

test.describe.configure({ mode: 'serial' });

/**
 * Deletes the account's profile through the API, as "Delete my profile" does. Never calls
 * GET /api/me afterwards: that creates the profile again.
 */
async function deleteProfile(role: Role): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL, storageState: statePath(role) });
  try {
    const res = await ctx.delete('/api/me');
    expect(res.status(), `DELETE /api/me as the ${role}: ${await res.text()}`).toBe(200);
  } finally {
    await ctx.dispose();
  }
}

// Donor first: a pledge from a donor who is gone stays on the researcher's project as Anonymous.
const cleanUp = async () => {
  for (const role of ['donor', 'researcher'] as const) await deleteProfile(role);
};
test.beforeAll(cleanUp);
test.afterAll(cleanUp);

async function signedIn(browser: Browser, role: Role): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: statePath(role) });
  const page = await context.newPage();
  // Every confirm() the flow meets is one a person would accept.
  page.on('dialog', (d) => void d.accept());
  return { context, page };
}

test('researcher posts a project, donor pledges by hand, researcher confirms and posts results', async ({ browser }) => {
  const researcher = await signedIn(browser, 'researcher');
  const donor = await signedIn(browser, 'donor');
  let projectPath = '';

  await test.step('both accounts are signed in with Microsoft', async () => {
    for (const who of [researcher, donor]) {
      const me = await who.context.request.get('/.auth/me');
      expect((await me.json()).clientPrincipal?.identityProvider).toBe('aad');
    }
  });

  await test.step('researcher saves a profile and posts a project', async () => {
    await saveProfile(researcher.page, { displayName: names.researcher, atlasEmail: RESEARCHER_ATLAS_EMAIL });
    await expect(researcher.page.getByText('Signed in with Microsoft')).toBeVisible();
    projectPath = await postProjectInForm(researcher.page, {
      title,
      summary: `Automated full-flow test run ${run}. Nothing is measured.`,
      description: `Posted by the Atlas Relay full-flow tests (run ${run}).\n\nThe tests delete this account's profile when they finish, which closes the project.`,
      creditsRequested: credits,
      tags: ['ping'],
    });
  });

  await test.step('donor pledges to transfer by hand and marks the credits sent', async () => {
    const { page } = donor;
    await saveProfile(page, { displayName: names.donor, atlasEmail: '' });
    await page.goto(projectPath);
    const done = await pledgeByHand(page, { amount: credits, message: `Full-flow test ${run}` });
    // The donor is shown where to send the credits.
    await expect(done.locator('.copy-box')).toContainText(RESEARCHER_ATLAS_EMAIL);
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(pledgeRow(page, names.donor).getByText('Pledged', { exact: true })).toBeVisible();
    await markSent(page, names.donor);
  });

  await test.step('researcher confirms the credits arrived and posts results', async () => {
    const { page } = researcher;
    await page.goto(projectPath);
    await confirmReceived(page, names.donor);
    await expect(page.locator('dl.kv')).toContainText(`Received${credits}`);
    await expect(page.locator('.pill-green', { hasText: 'Funded' })).toBeVisible();
    const section = await postResults(page, { summary: resultsSummary, url: 'https://example.org/atlasrelay-e2e' });
    await expect(section.getByText(resultsSummary)).toBeVisible();
  });

  await test.step('a visitor sees the funded project, the pledge and the results, and not the email', async () => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(projectPath);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(pledgeRow(page, names.donor)).toContainText('Confirmed');
    await expect(page.getByText(resultsSummary)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(RESEARCHER_ATLAS_EMAIL);
    await visitor.close();
  });

  await researcher.context.close();
  await donor.context.close();
});
