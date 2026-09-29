// SEO smoke tests on the files the site is served from: index.html, the page shells the build
// writes from it, staticwebapp.config.json, robots.txt, the share image and the IndexNow key.
// There is no browser test setup in this repository, so these read the files rather than a
// rendered page; the checks mirror the ones the owner's other sites run in Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, documentTitle, HOME_TITLE, renderShell, ROOT_END, ROOT_START, SHELLS, SITE_ORIGIN, type Shell } from '../src/lib/pages.ts';
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
  assert.equal(SITE_ORIGIN, 'https://www.atlasrelay.org');
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
  const copy = [indexHtml, read('src/lib/pages.ts')].join('\n');
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

/**
 * What Static Web Apps answers for a GET, following the documented rules: the first matching
 * route wins, a trailing * matches everything under the prefix, then a deployed file, then the
 * 404 override. There is no navigation fallback, so nothing else returns the app.
 */
function resolve(path: string): { status: number; serves: string } {
  const rule = config.routes.find((r) =>
    (!r.methods || r.methods.includes('GET')) && (r.route.endsWith('*') ? path.startsWith(r.route.slice(0, -1)) : r.route === path),
  );
  if (rule?.redirect) return { status: rule.statusCode ?? 302, serves: rule.redirect };
  const target = rule?.rewrite ?? (path === '/' ? '/index.html' : path);
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

test('every rewrite lands on a file the build writes, or on the API', () => {
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
    assert.ok(builtFiles.has(got.serves), `${url} serves ${got.serves}`);
  }
});

test('each route gets the shell with the matching head', () => {
  assert.equal(resolve('/').serves, '/index.html');
  assert.equal(resolve('/projects').serves, '/shell/projects.html');
  assert.equal(resolve('/how-it-works').serves, '/shell/how-it-works.html');
  assert.equal(resolve('/projects/mf1abcd0000xyz12').serves, '/shell/project.html');
  for (const p of ['/dashboard', '/profile', '/projects/new']) assert.equal(resolve(p).serves, '/shell/app.html');
});

test('unknown paths return 404 with the not-found page', () => {
  for (const p of ['/does-not-exist', '/projectsx', '/how-it-works/more', '/dashboard/x', '/index.php', '/assets']) {
    assert.deepEqual(resolve(p), { status: 404, serves: '/404.html' }, p);
  }
});

test('the static files are served as themselves', () => {
  for (const p of ['/robots.txt', '/og-image.png', '/favicon.svg', '/fonts.js']) assert.deepEqual(resolve(p), { status: 200, serves: p });
});

test('/sitemap.xml is generated by the API, not answered with the app', () => {
  assert.deepEqual(resolve('/sitemap.xml'), { status: 200, serves: '/api/sitemap' });
});

// ---------- robots.txt, sitemap and IndexNow ----------

test('robots.txt keeps the API out and names the sitemap', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE_ORIGIN.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});

test('the IndexNow key file is served from the site root and holds its own key', () => {
  const key = findKey(join(web, 'public'));
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(resolve(`/${key}.txt`).status, 200);
  assert.ok(existsSync(join(web, 'public', `${key}.txt`)));
});

test('the IndexNow script reads every <loc> from a sitemap and unescapes it', () => {
  const xml = '<urlset><url><loc>https://www.atlasrelay.org/</loc></url><url><loc> https://www.atlasrelay.org/a?b=1&amp;c=2 </loc><lastmod>2026-09-20</lastmod></url></urlset>';
  assert.deepEqual(extractLocs(xml), ['https://www.atlasrelay.org/', 'https://www.atlasrelay.org/a?b=1&c=2']);
});
