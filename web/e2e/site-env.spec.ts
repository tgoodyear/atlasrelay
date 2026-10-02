import { expect, test } from '@playwright/test';

// The production build (no VITE_SITE_ENV) has no test site banner and no blanket noindex. The
// test-site build is checked in e2e/test-site.

test('the production build has no test site banner and no blanket noindex', async ({ page, request }) => {
  await page.route('**/.auth/me', (route) => route.fulfill({ json: { clientPrincipal: null } }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'not in this test' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#site-env-banner')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: https://atlasrelay.org/sitemap.xml');
  expect(robots).not.toMatch(/^Disallow: \/$/m);
  const config = await (await request.get('/staticwebapp.config.json')).json();
  expect(Object.keys(config.globalHeaders).map((h) => h.toLowerCase())).not.toContain('x-robots-tag');
  expect(config.routes.find((r: { route: string }) => r.route === '/sitemap.xml')).toEqual({ route: '/sitemap.xml', rewrite: '/api/sitemap' });
  for (const file of ['/shell/privacy.html', '/404.html']) expect(await (await request.get(file)).text(), file).not.toContain('site-env-banner');
});
