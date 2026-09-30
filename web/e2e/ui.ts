import { expect, type Locator, type Page } from '@playwright/test';

// Steps a person takes on the site's pages, shared by the full-flow tests on the local stack
// (e2e/flows) and the ones against a deployed site with real Microsoft sign-in (e2e-real/ at the
// repository root). Each step waits for the page to show that it worked.

/** The profile form: saves a display name and a RIPE NCC Access email ('' for none). */
export async function saveProfile(page: Page, profile: { displayName: string; atlasEmail: string }): Promise<void> {
  await page.goto('/profile');
  await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
  await page.getByLabel('Display name').fill(profile.displayName);
  await page.getByLabel('RIPE NCC Access email').fill(profile.atlasEmail);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
}

export interface ProjectForm {
  title: string;
  summary: string;
  description: string;
  creditsRequested: number;
  tags: string[];
}

/** Posts a project through /projects/new and returns its path, e.g. /projects/abc123. */
export async function postProjectInForm(page: Page, project: ProjectForm): Promise<string> {
  await page.goto('/projects/new');
  await page.getByLabel('Title').fill(project.title);
  await page.getByLabel('One-paragraph summary').fill(project.summary);
  await page.getByLabel('Full description').fill(project.description);
  await page.getByLabel('Credits needed').fill(String(project.creditsRequested));
  for (const tag of project.tags) await page.getByRole('checkbox', { name: tag, exact: true }).check();
  await page.getByRole('button', { name: 'Publish project' }).click();
  await expect(page).toHaveURL(/\/projects\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole('heading', { level: 1, name: project.title })).toBeVisible();
  return new URL(page.url()).pathname;
}

/** A pledge on a project page, found by the donor's name. */
export function pledgeRow(page: Page, donorName: string): Locator {
  return page.locator('.pledge').filter({ hasText: donorName });
}

/**
 * On a project page, as a donor: pledge to transfer by hand. The amount is the form's default
 * unless given. Returns the dialog that shows where to send the credits; its Done button closes it.
 */
export async function pledgeByHand(page: Page, opts: { amount?: number; message?: string } = {}): Promise<Locator> {
  await page.getByRole('button', { name: 'Send credits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send credits' });
  if (opts.amount !== undefined) await dialog.getByLabel('Amount').fill(String(opts.amount));
  await dialog.getByRole('radio', { name: /I'll transfer on atlas.ripe.net myself/ }).check();
  await expect(dialog.getByLabel('RIPE Atlas API key')).toHaveCount(0);
  if (opts.message) await dialog.getByLabel('Message (optional, public)').fill(opts.message);
  await dialog.getByRole('button', { name: 'Create pledge' }).click();
  const done = page.getByRole('dialog', { name: 'Finish the transfer on atlas.ripe.net' });
  await expect(done.getByText('Pledge recorded. Now make the transfer on RIPE Atlas.')).toBeVisible();
  return done;
}

/** On a project page, as the donor: "I've sent the credits". */
export async function markSent(page: Page, donorName: string): Promise<void> {
  const row = pledgeRow(page, donorName);
  await row.getByRole('button', { name: "I've sent the credits" }).click();
  await expect(row.getByText('Sent, awaiting confirmation')).toBeVisible();
}

/** On a project page, as the owner: "Confirm received". */
export async function confirmReceived(page: Page, donorName: string): Promise<void> {
  const row = pledgeRow(page, donorName);
  await row.getByRole('button', { name: 'Confirm received' }).click();
  await expect(row.getByText('Confirmed', { exact: true })).toBeVisible();
}

/**
 * On a project page, as the owner: edit the project and save a results summary and link ('' clears
 * them). Returns the page's Results section.
 */
export async function postResults(page: Page, results: { summary: string; url: string }): Promise<Locator> {
  const projectPath = new URL(page.url()).pathname;
  await page.getByRole('link', { name: 'Edit project' }).click();
  await page.getByLabel('Results', { exact: true }).fill(results.summary);
  await page.getByLabel('Link to the results').fill(results.url);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'Results' }) });
}
