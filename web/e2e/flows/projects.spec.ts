import { expect, test, uid } from './fixtures';

// A researcher posts a project through the form, it is listed and served with its own head, and the
// owner edits it.

function headOf(html: string) {
  const meta = (attr: string, name: string) =>
    html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
  return {
    title: html.match(/<title>([^<]*)<\/title>/)?.[1],
    description: meta('name', 'description'),
    ogTitle: meta('property', 'og:title'),
    ogDescription: meta('property', 'og:description'),
    ogUrl: meta('property', 'og:url'),
    canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1],
    robots: meta('name', 'robots'),
  };
}

test('researcher adds a RIPE email, posts a project, and edits it', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher', profile: 'name' });
  const { page } = researcher;
  const tag = uid();
  const title = `IPv6 reachability study ${tag}`;
  const summary = `Traceroutes from every probe in one country, ${tag}.`;

  // No RIPE email yet, so the form sends the researcher to the profile first and back again.
  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: 'Add your RIPE NCC Access email' })).toBeVisible();
  await page.getByRole('link', { name: 'Add my RIPE email' }).click();
  await expect(page).toHaveURL(/\/profile\?next=\/projects\/new$/);
  await expect(page.getByText('Add your RIPE NCC Access email first')).toBeVisible();
  await page.getByLabel('RIPE NCC Access email').fill(`researcher-${tag}@example.org`);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expect(page.getByRole('heading', { name: 'Post a project' })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByLabel('One-paragraph summary').fill(summary);
  await page.getByLabel('Full description').fill('Probe selection and schedule.\n\nResults go to RIPE Labs.');
  await page.getByLabel('Credits needed').fill('2500');
  await page.getByRole('checkbox', { name: 'traceroute' }).check();
  await page.getByRole('checkbox', { name: 'ipv6' }).check();
  // The browser accepts an http:// URL; the API allows https:// only.
  await page.getByLabel('Paper or proposal').fill('http://example.org/proposal.pdf');
  await page.getByRole('button', { name: 'Publish project' }).click();
  await expect(page.locator('.alert-error')).toHaveText('Paper or proposal must start with https://');

  await page.getByLabel('Paper or proposal').fill('https://example.org/proposal.pdf');
  await page.getByRole('button', { name: 'Publish project' }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9]{12,32}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(`by ${researcher.name}`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Paper / proposal' })).toHaveAttribute('href', 'https://example.org/proposal.pdf');
  await expect(page.getByText('Be the first to send credits.')).toBeVisible();
  await expect(page).toHaveTitle(`${title} | Atlas Relay`);

  // The abuse report link names the project.
  const report = page.getByRole('link', { name: 'Report this project' });
  const href = new URL((await report.getAttribute('href'))!);
  expect(href.origin + href.pathname).toBe('https://github.com/tgoodyear/atlasrelay/issues/new');
  expect(href.searchParams.get('labels')).toBe('abuse');
  expect(href.searchParams.get('title')).toBe(`Report a project: ${title}`);

  // Somebody else sees it on the listing, in the sitemap, and in the page the project-page function renders.
  const visitor = await signedOut();
  await visitor.page.goto(`/projects?q=${tag}`);
  await expect(visitor.page.getByRole('link', { name: title })).toBeVisible();
  await visitor.page.getByRole('link', { name: title }).click();
  await expect(visitor.page).toHaveURL(new RegExp(`/projects/${id}$`));
  await expect(visitor.page.getByRole('link', { name: 'Sign in to send credits' })).toBeVisible();
  // Signing in from here comes back to the project.
  await visitor.page.getByRole('link', { name: 'Sign in to send credits' }).click();
  await expect(visitor.page).toHaveURL(new RegExp(`/signin\\?next=%2Fprojects%2F${id}$`));
  await expect(visitor.page.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', `/.auth/login/github?post_login_redirect_uri=%2Fprojects%2F${id}`);

  const sitemap = await (await visitor.request.get('/sitemap.xml')).text();
  expect(sitemap).toContain(`<loc>https://atlasrelay.org/projects/${id}</loc>`);

  const served = await visitor.request.get(`/projects/${id}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-security-policy']).toContain("default-src 'self'");
  const head = headOf(await served.text());
  expect(head).toMatchObject({
    title: `${title} | Atlas Relay`,
    description: summary,
    ogTitle: `${title} | Atlas Relay`,
    ogDescription: summary,
    ogUrl: `https://atlasrelay.org/projects/${id}`,
    canonical: `https://atlasrelay.org/projects/${id}`,
  });

  // The owner edits it.
  const newTitle = `${title} (revised)`;
  await page.getByRole('link', { name: 'Edit project' }).click();
  await expect(page.getByRole('heading', { name: 'Edit project' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await page.getByLabel('Title').fill(newTitle);
  await page.getByLabel('Credits needed').fill('3000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: newTitle })).toBeVisible();
  await expect(page.getByText('0 of 3,000 credits')).toBeVisible();
  await expect(page).toHaveTitle(`${newTitle} | Atlas Relay`);
  expect(headOf(await (await page.request.get(`/projects/${id}`)).text()).title).toBe(`${newTitle} | Atlas Relay`);

  // Another signed-in user gets no edit controls and cannot edit through the API.
  const other = await person({ role: 'other' });
  await other.page.goto(`/projects/${id}`);
  await expect(other.page.getByRole('button', { name: 'Send credits' })).toBeVisible();
  await expect(other.page.getByRole('link', { name: 'Edit project' })).toHaveCount(0);
  expect((await other.request.patch(`/api/projects/${id}`, { data: { title: 'hijacked' } })).status()).toBe(403);
});

test('unknown pages and projects are 404s', async ({ signedOut }) => {
  const { page } = await signedOut();

  // A well-formed id that does not exist: the project-page function answers 404, and so does the API.
  const missing = 'zzzzzzzzzzzz0000';
  const res = await page.goto(`/projects/${missing}`);
  expect(res?.status()).toBe(404);
  expect(headOf(await res!.text()).robots).toContain('noindex');
  await expect(page.getByRole('heading', { level: 1, name: 'Project not found' })).toBeVisible();
  expect((await page.request.get(`/api/projects/${missing}`)).status()).toBe(404);

  // A malformed id and an unknown path get the static 404 page.
  for (const path of [`/projects/NOT-AN-ID`, `/no-such-page-${uid()}`]) {
    const r = await page.goto(path);
    expect(r?.status(), path).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/not found/);
  }
  await expect(page.getByRole('link', { name: 'Back to the front page' })).toBeVisible();
});
