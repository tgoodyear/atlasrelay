import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';

// Read-only checks for a deployed site (playwright.smoke.config.ts, BASE_URL=...). They send GET and
// HEAD requests only: no sign-in, no writes. The same file runs against the local stack in
// playwright.flows.config.ts, so it is exercised on every pull request.

const SITE_ORIGIN = 'https://atlasrelay.org';

const PAGES = [
  { path: '/', h1: 'Donate spare RIPE Atlas credits to measurement research' },
  { path: '/projects', h1: 'Projects' },
  { path: '/how-it-works', h1: /.+/ },
  { path: '/privacy', h1: /.+/ },
];

function expectSecurityHeaders(res: APIResponse): void {
  const h = res.headers();
  expect(h['content-security-policy'], res.url()).toContain("default-src 'self'");
  expect(h['content-security-policy'], res.url()).toContain("frame-ancestors 'none'");
  expect(h['x-content-type-options'], res.url()).toBe('nosniff');
  expect(h['referrer-policy'], res.url()).toBe('strict-origin-when-cross-origin');
  expect(h['permissions-policy'], res.url()).toContain('camera=()');
  // HSTS only means anything over HTTPS, and the local stack serves plain HTTP.
  if (res.url().startsWith('https:')) expect(h['strict-transport-security'], res.url()).toContain('max-age=');
}

function canonicalOf(html: string): string | undefined {
  return html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
}

function robotsOf(html: string): string | undefined {
  return html.match(/<meta name="robots" content="([^"]*)"/)?.[1];
}

/** Keep browser telemetry out of the site's traffic figures. */
async function blockTelemetry(context: BrowserContext): Promise<void> {
  await context.route(/\.in\.applicationinsights\.azure\.com\//, (route) => route.abort('blockedbyclient'));
}

test.beforeEach(async ({ context }) => {
  await blockTelemetry(context);
});

for (const p of PAGES) {
  test(`page ${p.path} is served with its own head and security headers, and loads cleanly`, async ({ page, request }) => {
    const res = await request.get(p.path);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expectSecurityHeaders(res);
    const html = await res.text();
    expect(html).toMatch(/<title>[^<]*Atlas Relay[^<]*<\/title>/);
    expect(canonicalOf(html)).toBe(`${SITE_ORIGIN}${p.path === '/' ? '/' : p.path}`);

    // In a browser: the app renders and nothing is refused (a CSP violation is a console error).
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('ERR_BLOCKED_BY_CLIENT')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(p.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.h1);
    await page.waitForLoadState('networkidle');
    expect(problems).toEqual([]);
  });
}

test('unknown pages and projects are 404s that search engines skip', async ({ page, request, baseURL }) => {
  // Azure adds the global headers to the static 404 page; the local emulator does not.
  const emulator = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(baseURL ?? '');
  for (const path of ['/no-such-page-smoke', '/projects/zzzzzzzzzzzz0000', '/projects/NOT-AN-ID']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(robotsOf(await res.text()), path).toContain('noindex');
    if (!(emulator && path === '/no-such-page-smoke')) expectSecurityHeaders(res);
  }
  await page.goto('/no-such-page-smoke');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});

test('robots.txt and the sitemap, and a project page from it', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);

  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
  const xml = await sitemap.text();
  expect(xml).toContain('<urlset');
  expect(xml).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
  expect(xml).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);

  // Any project in the sitemap is served by the project-page function with its own head.
  const projectUrl = xml.match(new RegExp(`<loc>(${SITE_ORIGIN}/projects/[a-z0-9]{12,32})</loc>`))?.[1];
  test.skip(!projectUrl, 'The sitemap lists no projects');
  const path = new URL(projectUrl!).pathname;
  const res = await request.get(path);
  expect(res.status()).toBe(200);
  expectSecurityHeaders(res);
  const html = await res.text();
  expect(canonicalOf(html)).toBe(projectUrl);
  expect(html).toContain(`<meta property="og:url" content="${projectUrl}"`);
  expect(robotsOf(html) ?? '').not.toContain('noindex');
  expect((await request.head(path)).status()).toBe(200);
});

test('public API answers, and private routes need a sign-in', async ({ request }) => {
  const stats = await request.get('/api/stats');
  expect(stats.status()).toBe(200);
  const s = (await stats.json()).stats;
  for (const k of ['projects', 'openProjects', 'creditsRequested', 'creditsTransferred', 'fundedProjects', 'projectsWithResults']) {
    expect(typeof s[k], k).toBe('number');
  }

  const list = await request.get('/api/projects?status=all');
  expect(list.status()).toBe(200);
  const { projects } = await list.json();
  expect(Array.isArray(projects)).toBe(true);
  for (const p of projects) {
    expect(p).not.toHaveProperty('ownerId');
    expect(p).not.toHaveProperty('atlasEmail');
  }
  if (projects.length > 0) {
    const detail = await request.get(`/api/projects/${projects[0].id}`);
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.project.id).toBe(projects[0].id);
    expect(body.viewer).toBeNull();
    expect(JSON.stringify(body)).not.toContain('atlasEmail');
  }
  expect((await request.get('/api/projects/zzzzzzzzzzzz0000')).status()).toBe(404);

  const principal = await request.get('/.auth/me');
  expect(principal.status()).toBe(200);
  expect((await principal.json()).clientPrincipal).toBeNull();
  for (const path of ['/api/me', '/api/my']) {
    expect((await request.get(path)).status(), path).toBe(401);
  }

  const login = await request.get('/login', { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  expect(login.headers()['location']).toContain('/.auth/login/github');
});
