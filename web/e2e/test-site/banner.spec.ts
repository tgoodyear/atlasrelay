import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The test-site build (VITE_SITE_ENV=dev, the way dev is built; see src/lib/siteEnv.ts and the
// test-site project in playwright.config.ts): every page starts with the banner, and nothing on
// the site invites a search engine in. The tests answer /.auth and /api themselves.

async function stub(page: Page): Promise<void> {
  await page.route('**/.auth/me', (route) => route.fulfill({ json: { clientPrincipal: null } }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'not in this test' } }));
}

const banner = (page: Page) => page.getByRole('region', { name: 'Test site notice' });

for (const path of ['/', '/how-it-works', '/privacy', '/no-such-page']) {
  test(`${path} shows the test site banner and passes axe`, async ({ page }) => {
    await stub(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('This is a test site with fake projects, but credit transfers here move real RIPE Atlas credits.');
    await expect(banner(page).getByRole('link', { name: 'atlasrelay.org' })).toHaveAttribute('href', 'https://atlasrelay.org/');
    // It is the first thing on the page, above the header.
    const top = await banner(page).boundingBox();
    expect(top?.y).toBe(0);
    await expect(page.locator('meta[name="robots"][data-site-env]')).toHaveAttribute('content', 'noindex, nofollow');
    await page.waitForLoadState('networkidle');
    const { violations } = await new AxeBuilder({ page }).include(`#site-env-banner`).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

test('moving around the app keeps the banner and the noindex tag', async ({ page }) => {
  await stub(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'How it works' }).first().click();
  await expect(page).toHaveURL(/\/how-it-works$/);
  await expect(banner(page)).toBeVisible();
  // usePageMeta removes the page's own robots tag on an indexable page; the test site's stays.
  await expect(page.locator('meta[name="robots"][data-site-env]')).toHaveCount(1);
});

test('robots.txt disallows everything, and the build has no sitemap route or IndexNow key', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toBe('User-agent: *\nDisallow: /\n');
  const config = await (await request.get('/staticwebapp.config.json')).json();
  expect(config.globalHeaders['x-robots-tag']).toBe('noindex, nofollow');
  expect(config.globalHeaders['content-security-policy']).toContain("default-src 'self'");
  expect(config.routes.find((r: { route: string }) => r.route === '/sitemap.xml')).toEqual({ route: '/sitemap.xml', statusCode: 404 });
  for (const file of ['/shell/privacy.html', '/shell/project.html', '/404.html']) {
    const html = await (await request.get(file)).text();
    expect(html, file).toContain('id="site-env-banner"');
    expect(html, file).toContain('<meta name="robots" content="noindex, nofollow" data-site-env />');
  }
  // vite preview answers a missing file with the app, so check the body is not the key.
  const key = '7e118fdc4957f14e8d5276641754f632';
  expect((await (await request.get(`/${key}.txt`)).text()).trim()).not.toBe(key);
});
