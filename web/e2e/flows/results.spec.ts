import { expect, postProject, test } from './fixtures';

// The owner reports what came of the work, and the project shows it.

test('researcher posts results and the project shows them', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher, { creditsRequested: 300 });
  const statsBefore = (await (await researcher.request.get('/api/stats')).json()).stats;

  const { page } = researcher;
  await page.goto(`/projects/${project.id}`);
  // Open and unfunded, with nothing reported: no results section yet.
  await expect(page.getByRole('heading', { name: 'Results' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Edit project' }).click();
  const summary = `We ran 40,000 traceroutes. Write-up for ${project.title}.`;
  await page.getByLabel('Results', { exact: true }).fill(summary);
  await page.getByLabel('Link to the results').fill('https://example.org/results');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));

  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Results' }) });
  await expect(section.getByText(summary)).toBeVisible();
  await expect(section.getByText(/^Posted /)).toBeVisible();
  await expect(section.getByRole('link', { name: 'Read the results' })).toHaveAttribute('href', 'https://example.org/results');
  await expect(page.locator('.pill-navy', { hasText: 'Results' })).toBeVisible();

  // Visitors see it too, and the listing filter finds it.
  const visitor = await signedOut();
  await visitor.page.goto(`/projects/${project.id}`);
  await expect(visitor.page.getByText(summary)).toBeVisible();
  await visitor.page.goto(`/projects?status=results&q=${encodeURIComponent(project.title)}`);
  await expect(visitor.page.getByRole('link', { name: project.title })).toBeVisible();
  const stats = (await (await visitor.request.get('/api/stats')).json()).stats;
  expect(stats.projectsWithResults).toBeGreaterThanOrEqual(statsBefore.projectsWithResults + 1);

  // Emptying both fields later does not erase the fact that results were posted.
  await page.getByRole('link', { name: 'Edit project' }).click();
  await page.getByLabel('Results', { exact: true }).fill('');
  await page.getByLabel('Link to the results').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('The owner posted results here and has since removed them.')).toBeVisible();
});
