// Which environment a build is for, and what a test environment's build changes. vite.config.ts
// applies it at build time. Nothing in this file may touch the DOM or Node APIs.
//
// The build reads VITE_SITE_ENV. Empty or unset (the default) and "prod" build the production
// site, so a build that forgets the variable is always prod, never a test site. Any other
// environment name (the names scripts/bootstrap.sh accepts, such as "dev") builds a test site:
//
//   - every response carries X-Robots-Tag: noindex, nofollow (staticwebapp.config.json
//     globalHeaders), and every HTML page a robots meta tag saying the same;
//   - robots.txt names no sitemap but lets crawlers in, because a crawler only sees noindex on a page
//     it may fetch (dev was crawlable before), /sitemap.xml answers 404, and the
//     IndexNow key file is left out (scripts/indexnow.mjs only ever submits atlasrelay.org);
//   - every page starts with a banner saying it is a test site and linking to the real one.
//
// The Full-flow tests on dev workflow and scripts/run-e2e.sh set it; the Deploy workflow does not.

import { escapeHtml, SITE_ORIGIN } from './pages';

export type SiteEnv = { prod: true; name: 'prod' } | { prod: false; name: string };

export const PROD: SiteEnv = { prod: true, name: 'prod' };

/** The environment names scripts/bootstrap.sh and scripts/lib/e2e-job.sh accept. */
const ENV_NAME = /^[a-z][a-z0-9]{0,5}$/;

/** Reads VITE_SITE_ENV. Throws on a value that is not an environment name. */
export function parseSiteEnv(value: string | undefined): SiteEnv {
  const name = (value ?? '').trim().toLowerCase();
  if (name === '' || name === 'prod') return PROD;
  if (!ENV_NAME.test(name)) throw new Error(`VITE_SITE_ENV: "${value}" is not an environment name; leave it unset for prod, or use e.g. dev`);
  return { prod: false, name };
}

export const NOINDEX = 'noindex, nofollow';

/**
 * The robots meta tag a test site's pages carry. The data attribute keeps it apart from the
 * per-page robots tag that pages.ts, usePageMeta and the API's project pages add and remove: their
 * patterns end at content="..." />, and usePageMeta skips any tag with the attribute.
 */
export const ROBOTS_META = `<meta name="robots" content="${NOINDEX}" data-site-env />`;
export const BANNER_ID = 'site-env-banner';
export const BANNER_LABEL = 'Test site notice';
export const BANNER_TEXT_BEFORE = 'This is a test site with fake projects, but credit transfers here move real RIPE Atlas credits. Use';
export const BANNER_LINK_TEXT = 'atlasrelay.org';

/** The banner's HTML. It sits outside #root, so React never replaces it. */
export function bannerHtml(): string {
  return (
    `<div id="${BANNER_ID}" class="site-env-banner" role="region" aria-label="${escapeHtml(BANNER_LABEL)}">` +
    `<p>${escapeHtml(BANNER_TEXT_BEFORE)} <a href="${SITE_ORIGIN}/">${escapeHtml(BANNER_LINK_TEXT)}</a> instead.</p>` +
    `</div>`
  );
}

/** index.html for a build: unchanged for prod; a test site gets the robots tag and the banner. */
export function siteEnvHtml(html: string, env: SiteEnv): string {
  if (env.prod) return html;
  const viewport = /<meta name="viewport" content="[^"]*" \/>/;
  const body = /<body>/;
  if (!viewport.test(html) || !body.test(html)) throw new Error('index.html must contain the viewport meta tag and a plain <body> tag');
  return html
    .replace(viewport, (tag) => `${tag}\n    ${ROBOTS_META}`)
    .replace(body, () => `<body>\n    ${bannerHtml()}`);
}

/**
 * robots.txt for a test site: no sitemap. Pages are not disallowed: a search engine only drops a
 * page it has already indexed once it fetches it and sees noindex, which robots.txt would stop
 * (https://developers.google.com/search/docs/crawling-indexing/block-indexing). The API stays
 * disallowed, as on prod.
 */
export const TEST_ROBOTS_TXT = '# A test site: every page carries noindex, so crawlers may fetch them to see it.\nUser-agent: *\nDisallow: /api/\n';

interface Route {
  route: string;
  rewrite?: string;
  statusCode?: number;
}

interface SwaConfig {
  routes: Route[];
  globalHeaders?: Record<string, string>;
}

/**
 * staticwebapp.config.json for a build: unchanged for prod. A test site adds X-Robots-Tag to the
 * headers every response carries, keeping the others, and answers /sitemap.xml with 404.
 */
export function siteEnvConfig<T extends SwaConfig>(base: T, env: SiteEnv): T {
  if (env.prod) return base;
  const routes = base.routes.map((r) => (r.route === '/sitemap.xml' ? { route: r.route, statusCode: 404 } : r)) as T['routes'];
  return { ...base, routes, globalHeaders: { ...base.globalHeaders, 'x-robots-tag': NOINDEX } };
}
