import { isId } from './ids';
import type { Project } from './store';

/**
 * The canonical origin every sitemap URL is written against. It has to match SITE_ORIGIN in
 * web/src/lib/pages.ts, which sets the canonical tags; test/sitemap.test.ts checks that it does.
 */
export const SITE_ORIGIN = 'https://www.atlasrelay.org';

/** Pages that exist whatever is in storage. Pages behind sign-in are left out. */
export const STATIC_PATHS = ['/', '/projects', '/how-it-works'];

/** The most URLs one sitemap file may list (sitemaps.org). */
export const MAX_URLS = 50000;

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Every project page anyone can open, apart from projects an operator took down. A closed project
 * stays in: its page is still public and is where a researcher's results are posted.
 *
 * Capped at MAX_URLS so the file stays valid. listProjects returns the newest first, so any cut
 * drops the oldest projects. Splitting into several files behind a sitemap index can wait until
 * the site is anywhere near that size.
 */
export function sitemapEntries(projects: Pick<Project, 'id' | 'moderationClosed' | 'updatedAt'>[]): SitemapEntry[] {
  const entries: SitemapEntry[] = STATIC_PATHS.map((path) => ({ loc: `${SITE_ORIGIN}${path}` }));
  for (const p of projects) {
    // The id goes into a URL, so anything that is not a well-formed id is skipped rather than
    // escaped. Every id this API writes passes.
    if (p.moderationClosed || !isId(p.id)) continue;
    const lastmod = ISO_DATE.exec(p.updatedAt)?.[0];
    entries.push({ loc: `${SITE_ORIGIN}/projects/${p.id}`, ...(lastmod ? { lastmod } : {}) });
  }
  return entries.slice(0, MAX_URLS);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((e) =>
    `  <url>\n    <loc>${escapeXml(e.loc)}</loc>\n${e.lastmod ? `    <lastmod>${escapeXml(e.lastmod)}</lastmod>\n` : ''}  </url>\n`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('')}</urlset>\n`;
}
