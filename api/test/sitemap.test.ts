import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_URLS, SITE_ORIGIN, STATIC_PATHS, sitemapEntries, sitemapXml } from '../src/lib/sitemap';

// process.cwd() is the api workspace when npm runs the tests; see source.test.ts.
const repoRoot = join(process.cwd(), '..');

const row = (id: string, over: { moderationClosed?: boolean; updatedAt?: string } = {}) => ({
  id,
  moderationClosed: false,
  updatedAt: '2026-09-20T10:00:00.000Z',
  ...over,
});

test('the sitemap origin is the canonical origin the web app declares', () => {
  const pages = readFileSync(join(repoRoot, 'web/src/lib/pages.ts'), 'utf8');
  const declared = /export const SITE_ORIGIN = '([^']+)';/.exec(pages)?.[1];
  assert.equal(declared, SITE_ORIGIN);
});

test('the static pages come first and carry no lastmod', () => {
  const entries = sitemapEntries([]);
  assert.deepEqual(entries.map((e) => e.loc), STATIC_PATHS.map((p) => `${SITE_ORIGIN}${p}`));
  assert.ok(entries.every((e) => e.lastmod === undefined));
});

test('every public project is listed with the date it last changed', () => {
  const entries = sitemapEntries([row('mf1abcd0000xyz12'), row('mf1abcd0000xyz13', { updatedAt: '2026-01-02T00:00:00Z' })]);
  assert.deepEqual(entries.slice(STATIC_PATHS.length), [
    { loc: `${SITE_ORIGIN}/projects/mf1abcd0000xyz12`, lastmod: '2026-09-20' },
    { loc: `${SITE_ORIGIN}/projects/mf1abcd0000xyz13`, lastmod: '2026-01-02' },
  ]);
});

test('the sitemap never lists more URLs than one file may hold', () => {
  const rows = Array.from({ length: MAX_URLS + 5 }, (_, i) => row(`mf1abcd${String(i).padStart(9, '0')}`));
  assert.equal(sitemapEntries(rows).length, MAX_URLS);
});

test('a project an operator took down is left out', () => {
  const entries = sitemapEntries([row('mf1abcd0000xyz12', { moderationClosed: true })]);
  assert.equal(entries.length, STATIC_PATHS.length);
});

test('a malformed id never reaches a URL', () => {
  const entries = sitemapEntries([row('../x'), row('<script>'), row('')]);
  assert.equal(entries.length, STATIC_PATHS.length);
});

test('a row with no usable date is listed without a lastmod', () => {
  const [entry] = sitemapEntries([row('mf1abcd0000xyz12', { updatedAt: '' })]).slice(STATIC_PATHS.length);
  assert.deepEqual(entry, { loc: `${SITE_ORIGIN}/projects/mf1abcd0000xyz12` });
});

test('the XML is a sitemaps.org urlset with one url per entry, escaped', () => {
  const xml = sitemapXml([{ loc: 'https://example.org/a?b=1&c=<2>' }, { loc: 'https://example.org/d', lastmod: '2026-09-20' }]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n/);
  assert.equal(xml.match(/<url>/g)?.length, 2);
  assert.ok(xml.includes('<loc>https://example.org/a?b=1&amp;c=&lt;2&gt;</loc>'));
  assert.ok(xml.includes('<lastmod>2026-09-20</lastmod>'));
  assert.ok(xml.trimEnd().endsWith('</urlset>'));
});
