/**
 * The canonical origin and the site name, as the web app declares them in web/src/lib/pages.ts.
 * The sitemap, the canonical tags and the page titles all depend on the two agreeing, and
 * test/sitemap.test.ts and test/projectHtml.test.ts check that they do.
 *
 * This file imports nothing, so web/test/seo.test.ts can load the page renderer that uses it.
 */
export const SITE_ORIGIN = 'https://www.atlasrelay.org';
export const SITE_NAME = 'Atlas Relay';
