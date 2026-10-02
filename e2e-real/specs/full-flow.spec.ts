import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { confirmReceived, markSent, pledgeByHand, pledgeRow, postProjectInForm, postResults, saveProfile } from '../../web/e2e/ui';
import { RESEARCHER_ATLAS_EMAIL, type Role } from '../accounts';
import { cleanUpRun, deleteBothProfiles, signedIn } from '../site';

// The whole flow on a deployed site, as the two test accounts signed in with Microsoft
// (global-setup.ts), with the same page steps as the local full-flow tests (web/e2e/ui.ts): the
// researcher posts a project, the donor pledges to transfer by hand and says the credits are sent,
// the researcher confirms them and posts results. No credits move: a manual pledge only records
// what the donor says, and the researcher's RIPE NCC Access email is on a reserved domain.
// ripe-transfer.spec.ts moves real credits.
//
// Both profiles are deleted before and after the run. Before that, the project the run posted is
// deleted through the test-only cleanup route (site.ts, cleanUpRun), whether the test passed or
// not, so a run leaves nothing on the environment's listing or home-page figures.

const run = process.env.E2E_RUN_ID?.slice(-12) || randomBytes(4).toString('hex');
const names: Record<Role, string> = { researcher: `E2E researcher ${run}`, donor: `E2E donor ${run}` };
const title = `E2E full flow ${run}`;
const credits = 250;
const resultsSummary = `Results of full-flow test run ${run}.`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(deleteBothProfiles);
// Hooks run in the order they are declared, and a failing one does not stop the next.
test.afterAll(async ({}, testInfo) => cleanUpRun(run, testInfo));
test.afterAll(deleteBothProfiles);

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
      description: `Posted by the Atlas Relay full-flow tests (run ${run}).\n\nThe tests delete this project when they finish.`,
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
    const visitor = await browser.newContext({ baseURL: process.env.BASE_URL });
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
