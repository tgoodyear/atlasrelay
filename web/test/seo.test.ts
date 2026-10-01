// SEO smoke tests on the files the site is served from: index.html, the page shells the build
// writes from it, staticwebapp.config.json, robots.txt, the share image and the IndexNow key.
// There is no browser test setup in this repository, so these read the files rather than a
// rendered page; the checks mirror the ones the owner's other sites run in Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, DEFAULT_DESCRIPTION, documentTitle, HOME_TITLE, META, renderShell, ROOT_END, ROOT_START, SHELLS, SITE_ORIGIN, type Shell } from '../src/lib/pages.ts';
import * as server from '../../api/src/lib/projectHtml.ts';
import { loginUrl, offeredProviders, parseSignIn, providerLabel, providerList, safeReturnPath, signInConfig } from '../src/lib/signin.ts';
import { extractLocs, findKey } from '../../scripts/indexnow.mjs';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(web, path), 'utf8');
const indexHtml = read('index.html');

interface Route {
  route: string;
  rewrite?: string;
  redirect?: string;
  statusCode?: number;
  methods?: string[];
}
interface SwaConfig {
  trailingSlash?: 'auto' | 'always' | 'never';
  routes: Route[];
  navigationFallback?: unknown;
  responseOverrides?: Record<string, { rewrite?: string; statusCode?: number }>;
}
const config = JSON.parse(read('public/staticwebapp.config.json')) as SwaConfig;

function attr(html: string, selector: 'name' | 'property', key: string): string | undefined {
  const all = [...html.matchAll(new RegExp(`<meta ${selector}="${key}" content="([^"]*)" />`, 'g'))];
  assert.ok(all.length <= 1, `${key} appears ${all.length} times`);
  return all[0]?.[1];
}
const canonicalOf = (html: string): string | undefined => {
  const all = [...html.matchAll(/<link rel="canonical" href="([^"]*)" \/>/g)];
  assert.ok(all.length <= 1, `canonical appears ${all.length} times`);
  return all[0]?.[1];
};
const titleOf = (html: string): string | undefined => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const rootOf = (html: string): string => {
  const start = html.indexOf(ROOT_START);
  const end = html.indexOf(ROOT_END);
  assert.ok(start > 0 && end > start, 'the static content markers are present and in order');
  return html.slice(start, end);
};
const h1Count = (html: string): number => (html.match(/<h1[\s>]/g) ?? []).length;
function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

// ---------- index.html (the home page) ----------

test('the home page has a title and a meta description', () => {
  assert.equal(titleOf(indexHtml), HOME_TITLE);
  assert.ok(attr(indexHtml, 'name', 'description'));
});

test('the home page canonical is the canonical origin', () => {
  assert.equal(canonicalOf(indexHtml), `${SITE_ORIGIN}/`);
  assert.equal(SITE_ORIGIN, 'https://atlasrelay.org');
});

test('Open Graph and Twitter tags are complete and agree with the head', () => {
  const title = titleOf(indexHtml);
  const description = attr(indexHtml, 'name', 'description');
  assert.equal(attr(indexHtml, 'property', 'og:type'), 'website');
  assert.equal(attr(indexHtml, 'property', 'og:site_name'), 'Atlas Relay');
  assert.equal(attr(indexHtml, 'property', 'og:title'), title);
  assert.equal(attr(indexHtml, 'property', 'og:description'), description);
  assert.equal(attr(indexHtml, 'property', 'og:url'), canonicalOf(indexHtml));
  assert.equal(attr(indexHtml, 'property', 'og:image'), `${SITE_ORIGIN}/og-image.png`);
  assert.equal(attr(indexHtml, 'property', 'og:image:width'), '1200');
  assert.equal(attr(indexHtml, 'property', 'og:image:height'), '630');
  assert.ok(attr(indexHtml, 'property', 'og:image:alt'));
  assert.equal(attr(indexHtml, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(attr(indexHtml, 'name', 'twitter:title'), title);
  assert.equal(attr(indexHtml, 'name', 'twitter:description'), description);
  assert.equal(attr(indexHtml, 'name', 'twitter:image'), attr(indexHtml, 'property', 'og:image'));
  assert.ok(attr(indexHtml, 'name', 'twitter:image:alt'));
});

test('the share image is a 1200x630 PNG of reasonable size', () => {
  const png = readFileSync(join(web, 'public/og-image.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300 * 1024, `og-image.png is ${png.length} bytes`);
});

test('every JSON-LD block parses and declares the schema.org context', () => {
  const blocks = jsonLd(indexHtml);
  assert.ok(blocks.length > 0);
  for (const block of blocks) assert.equal(block['@context'], 'https://schema.org');
});

test('the JSON-LD describes the website and its publisher, with no search action', () => {
  const graph = jsonLd(indexHtml).flatMap((b) => (b['@graph'] as Record<string, unknown>[] | undefined) ?? [b]);
  const site = graph.find((n) => n['@type'] === 'WebSite');
  const org = graph.find((n) => n['@type'] === 'Organization');
  assert.ok(site && org);
  assert.equal(site.name, 'Atlas Relay');
  assert.equal(site.url, `${SITE_ORIGIN}/`);
  assert.equal(site.description, attr(indexHtml, 'name', 'description'));
  assert.deepEqual(site.publisher, { '@id': org['@id'] });
  assert.equal(org.url, `${SITE_ORIGIN}/`);
  assert.ok(!JSON.stringify(graph).includes('SearchAction'));
  assert.ok(!('potentialAction' in site));
});

test('the page has text before the app mounts, with exactly one h1', () => {
  const root = rootOf(indexHtml);
  assert.equal(h1Count(root), 1);
  assert.equal(h1Count(indexHtml), 1);
  assert.ok(root.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length > 100);
});

test('copy stays within the house rules', () => {
  const copy = [indexHtml, read('src/lib/pages.ts'), read('src/pages/Privacy.tsx')].join('\n');
  assert.ok(!copy.includes('\u2014'), 'no em dashes');
  assert.ok(!/marketplace|exchange/i.test(copy), 'Atlas Relay is never a marketplace or an exchange');
});

// ---------- the page shells ----------

const rendered = SHELLS.map((shell) => ({ shell, html: renderShell(indexHtml, shell) }));

for (const { shell, html } of rendered) {
  test(`${shell.file} has its own title, description and one h1`, () => {
    assert.equal(titleOf(html), documentTitle(shell.meta.title));
    assert.equal(attr(html, 'property', 'og:title'), documentTitle(shell.meta.title));
    assert.equal(attr(html, 'name', 'twitter:title'), documentTitle(shell.meta.title));
    const description = attr(html, 'name', 'description');
    assert.ok(description);
    assert.equal(attr(html, 'property', 'og:description'), description);
    assert.equal(h1Count(html), 1);
    assert.equal(h1Count(rootOf(html)), 1);
    for (const block of jsonLd(html)) assert.equal(block['@context'], 'https://schema.org');
  });

  test(`${shell.file} declares the right canonical URL, or none`, () => {
    const expected = shell.meta.path && !shell.meta.noindex ? canonicalUrl(shell.meta.path) : undefined;
    assert.equal(canonicalOf(html), expected);
    assert.equal(attr(html, 'property', 'og:url'), expected);
    assert.equal(attr(html, 'name', 'robots'), shell.meta.noindex ? 'noindex' : undefined);
    assert.ok(!/\n[ \t]*\n/.test(html.slice(0, html.indexOf('</head>'))), 'no blank lines left behind in the head');
  });
}

test('every shell has a distinct title', () => {
  const titles = rendered.map(({ html }) => titleOf(html));
  assert.equal(new Set(titles).size, titles.length);
});

test('page text is escaped into the shells', () => {
  const shell: Shell = { file: 'x.html', meta: { title: 'a "b" <c> & d', path: '/x' }, heading: '<script>', body: 'e & f' };
  const html = renderShell(indexHtml, shell);
  assert.ok(html.includes('<title>a &quot;b&quot; &lt;c&gt; &amp; d | Atlas Relay</title>'));
  assert.ok(html.includes('<h1>&lt;script&gt;</h1>'));
  assert.ok(!html.includes('<script>'));
});

test('a template change that breaks a pattern fails the build instead of shipping a wrong head', () => {
  assert.throws(() => renderShell(indexHtml.replace(/<link rel="canonical"[^>]*>/, ''), SHELLS[0]), /canonical/);
});

// ---------- routing: staticwebapp.config.json ----------

const publicFiles = new Set(readdirSync(join(web, 'public')).map((f) => `/${f}`));
const builtFiles = new Set(['/index.html', ...SHELLS.map((s) => `/${s.file}`)]);

/** The function staticwebapp.config.json sends every /projects/{id} URL to. */
const PROJECT_PAGE = '/api/project-page';

/**
 * What Static Web Apps answers for a GET, following the documented rules: the first matching
 * route wins, a trailing * matches everything under the prefix, then a deployed file, then the
 * 404 override. There is no navigation fallback, so nothing else returns the app. A path that
 * lands on a function gets whatever status the function returns; for the project page that is
 * modelled separately below.
 */
function resolve(path: string): { status: number; serves: string } {
  // The docs say trailingSlash "never" answers a path ending in a slash with a 301 to the path
  // without it. Production does not: on 2026-09-29 /how-it-works/, /projects/ and /dashboard/ all
  // came back 200 with the same page as the path without the slash. Route rules match as if the
  // slash were not there, so that is what this models. The canonical tags name the slashless URL.
  const bare = path !== '/' && path.endsWith('/') ? path.replace(/\/+$/, '') : path;
  const rule = config.routes.find((r) =>
    (!r.methods || r.methods.includes('GET')) && (r.route.endsWith('*') ? path.startsWith(r.route.slice(0, -1)) : r.route === bare),
  );
  if (rule?.redirect) return { status: rule.statusCode ?? 302, serves: rule.redirect };
  const target = rule?.rewrite ?? (bare === '' || bare === '/' ? '/index.html' : bare);
  if (target.startsWith('/api/')) return { status: 200, serves: target };
  if (builtFiles.has(target) || publicFiles.has(target) || target.startsWith('/assets/')) return { status: 200, serves: target };
  const override = config.responseOverrides?.['404'];
  return { status: override?.statusCode ?? 404, serves: override?.rewrite ?? '' };
}

test('there is no navigation fallback, so unknown paths can 404', () => {
  assert.equal(config.navigationFallback, undefined);
  assert.deepEqual(config.responseOverrides?.['404'], { rewrite: '/404.html', statusCode: 404 });
  assert.ok(builtFiles.has('/404.html'));
});

test('every rewrite lands on a file the build writes, or on a function the API registers', () => {
  const functions = [...read('../api/src/index.ts').matchAll(/import '\.\/functions\/(\w+)';/g)]
    .map((m) => read(`../api/src/functions/${m[1]}.ts`))
    .flatMap((src) => [...src.matchAll(/route: '([^']+)'/g)].map((m) => `/api/${m[1]}`));
  for (const r of config.routes.filter((x) => x.rewrite?.startsWith('/api/'))) {
    assert.ok(functions.includes(r.rewrite!), `${r.route} rewrites to ${r.rewrite}, which no function serves`);
  }
  for (const r of config.routes.filter((x) => x.rewrite)) {
    assert.ok(r.rewrite!.startsWith('/api/') || builtFiles.has(r.rewrite!), `${r.route} rewrites to ${r.rewrite}`);
  }
});

test('every route in the router is served with the app', () => {
  const app = read('src/App.tsx');
  const paths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
  assert.ok(paths.length >= 7, `found ${paths.length} routes in App.tsx`);
  assert.ok(app.includes('<Route index '), 'the home route');
  for (const p of ['', ...paths]) {
    const url = `/${p.replace(/:id/g, 'mf1abcd0000xyz12')}`;
    const got = resolve(url);
    assert.equal(got.status, 200, `${url} returned ${got.status}`);
    assert.ok(builtFiles.has(got.serves) || got.serves === PROJECT_PAGE, `${url} serves ${got.serves}`);
    // The project page function answers only the two project routes, and it starts from the
    // project shell, so they get the app too.
    if (got.serves === PROJECT_PAGE) assert.notEqual(server.parseProjectPath(url).kind, 'none', url);
  }
});

test('each route gets the shell with the matching head', () => {
  assert.equal(resolve('/').serves, '/index.html');
  assert.equal(resolve('/projects').serves, '/shell/projects.html');
  assert.equal(resolve('/how-it-works').serves, '/shell/how-it-works.html');
  assert.equal(resolve('/privacy').serves, '/shell/privacy.html');
  for (const p of ['/projects/mf1abcd0000xyz12', '/projects/mf1abcd0000xyz12/edit']) assert.equal(resolve(p).serves, PROJECT_PAGE, p);
  for (const p of ['/dashboard', '/profile', '/projects/new', '/signin']) assert.equal(resolve(p).serves, '/shell/app.html');
});

test('SWA would accept the routes: no two rules normalize to the same route', () => {
  // SWA matches routes case-insensitively and ignores a trailing slash, and it rejects the whole
  // config at deploy time when two rules collide (a "/projects/" redirect next to the "/projects"
  // rewrite did exactly that). Trailing slashes are handled by trailingSlash instead.
  const seen = new Map<string, string>();
  for (const r of config.routes) {
    const key = `${r.route.toLowerCase().replace(/(.)\/+$/, '$1')} ${[...(r.methods ?? [])].sort().join(',')}`;
    assert.ok(!seen.has(key), `${r.route} duplicates ${seen.get(key)}`);
    seen.set(key, r.route);
  }
  assert.equal(config.trailingSlash, 'never');
});

test('a trailing slash on a route gets the same page as the route without it', () => {
  for (const p of ['/projects', '/projects/new', '/how-it-works', '/privacy', '/dashboard', '/profile', '/projects/mf1abcd0000xyz12']) {
    assert.deepEqual(resolve(`${p}/`), resolve(p), `${p}/`);
  }
  assert.equal(server.parseProjectPath('/projects/mf1abcd0000xyz12/').kind, 'project');
});

test('unknown paths return 404 with the not-found page', () => {
  for (const p of ['/does-not-exist', '/projectsx', '/how-it-works/more', '/dashboard/x', '/index.php', '/assets']) {
    assert.deepEqual(resolve(p), { status: 404, serves: '/404.html' }, p);
  }
});

test('the static files are served as themselves', () => {
  for (const p of ['/robots.txt', '/og-image.png', '/favicon.svg']) assert.deepEqual(resolve(p), { status: 200, serves: p });
});

test('/sitemap.xml is generated by the API, not answered with the app', () => {
  assert.deepEqual(resolve('/sitemap.xml'), { status: 200, serves: '/api/sitemap' });
});

test('every other path under /projects/ reaches the project page function, which answers 404', () => {
  // The routing rules cannot tell a project id from anything else, so the function decides. See
  // api/test/projectPage.test.ts for its 200, 404 and fallback answers.
  for (const p of ['/projects/does-not-exist', '/projects/mf1abcd0000xyz12/pledges', '/projects/a/b/c', '/projects/NEW']) {
    assert.equal(resolve(p).serves, PROJECT_PAGE, p);
    assert.equal(server.parseProjectPath(p).kind, 'none', p);
  }
});

// ---------- the server-rendered project page ----------

const projectShell = rendered.find(({ shell }) => shell.file === 'shell/project.html')!.html;
const hostile = { id: 'mf1abcd0000xyz12', title: 'Anycast "catchments" </title><script>x()</script>', summary: `Line one\nline two & <b>three</b> ${'more '.repeat(60)}` };

test('the API renders project pages from the project shell, with the head usePageMeta sets', () => {
  const html = server.renderProjectPage(projectShell, hostile);
  // GET /api/projects/{id} returns projectHead as `page`, and ProjectDetail passes it to
  // usePageMeta with the project's path. That has to produce the head the server sent.
  const page = server.projectHead(hostile);
  const client = { title: documentTitle(page.title), description: page.description, url: canonicalUrl(`/projects/${hostile.id}`) };
  const esc = server.escapeHtml;
  assert.equal(titleOf(html), esc(client.title));
  assert.equal(attr(html, 'property', 'og:title'), esc(client.title));
  assert.equal(attr(html, 'name', 'twitter:title'), esc(client.title));
  assert.equal(attr(html, 'name', 'description'), esc(client.description));
  assert.equal(attr(html, 'property', 'og:description'), esc(client.description));
  assert.equal(attr(html, 'name', 'twitter:description'), esc(client.description));
  assert.equal(canonicalOf(html), client.url);
  assert.equal(attr(html, 'property', 'og:url'), client.url);
  assert.equal(attr(html, 'name', 'robots'), undefined);
  assert.equal(attr(html, 'property', 'og:image'), `${SITE_ORIGIN}/og-image.png`);
  assert.equal(h1Count(html), 1);
  assert.ok(!html.includes('<script>x()'));
  assert.ok(!/\n[ \t]*\n/.test(html.slice(0, html.indexOf('</head>'))), 'no blank lines left behind in the head');
});

test('a server-rendered project page differs from the project shell only in its head tags and #root text', () => {
  const html = server.renderProjectPage(projectShell, hostile);
  const strip = (h: string): string =>
    h
      .replace(/\n[ \t]*<(title|meta name="(description|robots|twitter:title|twitter:description)"|meta property="og:(title|description|url)"|link rel="canonical")[^\n]*/g, '')
      .replace(new RegExp(`${ROOT_START}[\\s\\S]*?${ROOT_END}`), '');
  assert.equal(strip(html), strip(projectShell));
});

test('the edit form and the fallback page get the heads the app gives them', () => {
  const edit = server.renderEditPage(projectShell);
  assert.equal(titleOf(edit), documentTitle(META.editProject.title));
  assert.equal(attr(edit, 'name', 'description'), DEFAULT_DESCRIPTION);
  assert.equal(attr(edit, 'name', 'robots'), 'noindex');
  assert.equal(canonicalOf(edit), undefined);
  const fallback = server.renderFallbackPage(projectShell);
  assert.equal(titleOf(fallback), documentTitle(META.project.title));
  assert.equal(attr(fallback, 'name', 'robots'), 'noindex');
});

test('the API and the web app agree on the default description', () => {
  assert.equal(server.DEFAULT_DESCRIPTION, DEFAULT_DESCRIPTION);
});

// ---------- robots.txt, sitemap and IndexNow ----------

test('robots.txt keeps the API out and names the sitemap', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE_ORIGIN.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
  // The edit form needs sign-in and nothing public links to it. The project page function serves
  // it with noindex; the Disallow also keeps crawlers from spending requests on it.
  assert.match(robots, /^Disallow: \/projects\/\*\/edit$/m);
});

test('the IndexNow key file is served from the site root and holds its own key', () => {
  const key = findKey(join(web, 'public'));
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(resolve(`/${key}.txt`).status, 200);
  assert.ok(existsSync(join(web, 'public', `${key}.txt`)));
});

test('the IndexNow script reads every <loc> from a sitemap and unescapes it', () => {
  const xml = '<urlset><url><loc>https://atlasrelay.org/</loc></url><url><loc> https://atlasrelay.org/a?b=1&amp;c=2 </loc><lastmod>2026-09-20</lastmod></url></urlset>';
  assert.deepEqual(extractLocs(xml), ['https://atlasrelay.org/', 'https://atlasrelay.org/a?b=1&c=2']);
});

// ---------- sign-in providers ----------

const loginBlocked = (c: SwaConfig, provider: string): boolean =>
  c.routes.some((r) => r.route === `/.auth/login/${provider}` && r.statusCode === 404);
const ALL_PROVIDERS = ['github', 'aad', 'google', 'orcid', 'facebook', 'twitter', 'apple'];

test('the committed config is the built-in sign-in site: GitHub and Microsoft only', () => {
  // Static Web Apps offers more providers than the site uses, and still sent /.auth/login/google and
  // /.auth/login/facebook on to the provider in 2026-10. Every one the site does not offer answers 404.
  assert.deepEqual(ALL_PROVIDERS.filter((p) => !loginBlocked(config, p)), ['github', 'aad']);
  assert.equal((config as { auth?: unknown }).auth, undefined, 'the build writes the auth section; web/public has none');
  // The build writes this same file for a build without VITE_SIGNIN_PROVIDERS.
  assert.deepEqual(signInConfig(config, parseSignIn(undefined)), config);
  assert.deepEqual(signInConfig(config, parseSignIn('')), config);
});

test('a custom sign-in build opens the providers it names, and keeps GitHub and Microsoft', () => {
  const all = signInConfig(config, parseSignIn('github,aad,google,orcid')) as SwaConfig & { auth: { identityProviders: Record<string, any> } };
  assert.deepEqual(ALL_PROVIDERS.filter((p) => !loginBlocked(all, p)), ['github', 'aad', 'google', 'orcid']);
  const idp = all.auth.identityProviders;
  assert.deepEqual(Object.keys(idp).sort(), ['azureActiveDirectory', 'customOpenIdConnectProviders', 'github', 'google']);
  assert.deepEqual(idp.github.registration, { clientIdSettingName: 'SIGNIN_GITHUB_CLIENT_ID', clientSecretSettingName: 'SIGNIN_GITHUB_CLIENT_SECRET' });
  assert.deepEqual(idp.google.registration, { clientIdSettingName: 'SIGNIN_GOOGLE_CLIENT_ID', clientSecretSettingName: 'SIGNIN_GOOGLE_CLIENT_SECRET' });
  assert.equal(idp.azureActiveDirectory.registration.openIdIssuer, 'https://login.microsoftonline.com/common/v2.0');
  const orcid = idp.customOpenIdConnectProviders.orcid;
  assert.equal(orcid.registration.openIdConnectConfiguration.wellKnownOpenIdConfiguration, 'https://orcid.org/.well-known/openid-configuration');
  // ORCID accepts only client_secret_post at its token endpoint.
  assert.deepEqual(orcid.registration.clientCredential, { method: 'ClientSecretPost', clientSecretSettingName: 'SIGNIN_ORCID_CLIENT_SECRET' });
  assert.deepEqual(orcid.login.scopes, ['openid']);
  // The iD is the "sub" claim; the account name must not be it, since it seeds the public display name.
  assert.equal(orcid.login.nameClaimType, 'name');
  // Only setting names, never values, are in the file that ships with the site.
  assert.doesNotMatch(JSON.stringify(all.auth), /"(clientSecret|clientId)"\s*:/);
  for (const [route, target] of [['/login/google', 'google'], ['/login/orcid', 'orcid'], ['/login', 'github'], ['/login/microsoft', 'aad']]) {
    assert.equal(all.routes.find((r) => r.route === route)?.redirect, `/.auth/login/${target}?post_login_redirect_uri=/dashboard`, route);
  }
  // Everything else is the committed file's, in its order.
  const rest = (c: SwaConfig) => c.routes.filter((r) => !/^\/(\.auth\/)?login\b/.test(r.route));
  assert.deepEqual(rest(all), rest(config));
});

test('a custom build that names one optional provider leaves the other closed', () => {
  const orcidOnly = signInConfig(config, parseSignIn('aad,orcid,github'));
  assert.deepEqual(ALL_PROVIDERS.filter((p) => !loginBlocked(orcidOnly, p)), ['github', 'aad', 'orcid']);
  assert.ok(!orcidOnly.routes.some((r) => r.route === '/login/google'));
  assert.equal(((orcidOnly as unknown as { auth: { identityProviders: Record<string, unknown> } }).auth.identityProviders).google, undefined);
});

test('the build refuses a sign-in setting that would drop GitHub or Microsoft, or names an unknown provider', () => {
  // Any custom provider turns the built-in ones off, so Google or ORCID alone would sign out every
  // GitHub and Microsoft account.
  assert.throws(() => parseSignIn('google'), /must include github and aad/);
  assert.throws(() => parseSignIn('github,orcid'), /must include aad/);
  assert.throws(() => parseSignIn('github,aad,facebook'), /unknown provider facebook/);
  assert.deepEqual(parseSignIn(' GitHub , aad,ORCID ').providers, ['github', 'aad', 'orcid']);
  assert.throws(() => signInConfig({ ...config, auth: {} }, parseSignIn('')), /written by the build/);
});

test('sign-in buttons match the build, and return paths stay on the site', () => {
  assert.deepEqual(offeredProviders(undefined).map((p) => p.label), ['GitHub', 'Microsoft']);
  assert.deepEqual(offeredProviders('github,aad,google,orcid').map((p) => p.label), ['GitHub', 'Microsoft', 'Google', 'ORCID']);
  assert.equal(providerLabel('orcid'), 'ORCID');
  assert.equal(providerList(offeredProviders('')), 'GitHub or Microsoft');
  assert.equal(providerList(offeredProviders('github,aad,google,orcid')), 'GitHub, Microsoft, Google or ORCID');
  assert.equal(providerLabel('aad'), 'Microsoft');
  assert.equal(providerLabel('facebook'), 'another provider');
  assert.equal(safeReturnPath('/projects/abc'), '/projects/abc');
  assert.equal(safeReturnPath('/projects?tag=dns#top'), '/projects?tag=dns#top');
  assert.equal(safeReturnPath('/projects/abc/../new'), '/projects/new');
  for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '', null, '/a\nb', '/a\tb', '/..//evil.example', '/.//evil.example', '/%2e%2e//evil.example', '/a/../..//evil.example', '/%2F%2Fevil.example', '/.auth/logout?post_logout_redirect_uri=/', '/logout', '/login/google', '/api/me', '/.auth/login/github']) {
    assert.equal(safeReturnPath(bad), '/dashboard', String(bad));
  }
  assert.equal(loginUrl('orcid', '/projects/abc'), '/.auth/login/orcid?post_login_redirect_uri=%2Fprojects%2Fabc');
});
