import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DESCRIPTION,
  DESCRIPTION_MAX,
  ROOT_TEXT_MAX,
  TITLE_MAX,
  clip,
  documentTitle,
  escapeHtml,
  oneLine,
  parseProjectPath,
  projectHead,
  renderEditPage,
  renderFallbackPage,
  renderProjectPage,
} from '../src/lib/projectHtml';
import { SITE_NAME, SITE_ORIGIN } from '../src/lib/site';

// process.cwd() is the api workspace when npm runs the tests; see source.test.ts.
const repoRoot = join(process.cwd(), '..');
// The source index.html has every tag the built shells have, plus a canonical URL and og:url, so
// rendering from it also covers removing those. web/test/seo.test.ts renders the built shell.
const template = readFileSync(join(repoRoot, 'web/index.html'), 'utf8');
const pagesTs = readFileSync(join(repoRoot, 'web/src/lib/pages.ts'), 'utf8');

const ID = 'mf1abcd0000xyz12';

function metaAll(html: string, attr: 'name' | 'property', key: string): string[] {
  return [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)" />`, 'g'))].map((m) => m[1]);
}
function meta(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const all = metaAll(html, attr, key);
  assert.ok(all.length <= 1, `${key} appears ${all.length} times`);
  return all[0];
}
const titles = (html: string): string[] => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
const canonicals = (html: string): string[] => [...html.matchAll(/<link rel="canonical" href="([^"]*)" \/>/g)].map((m) => m[1]);
const root = (html: string): string => /<!-- static-content -->([\s\S]*?)<!-- \/static-content -->/.exec(html)?.[1] ?? '';
const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The template with every tag the renderer owns taken out, to compare what is left. */
function untouched(html: string): string {
  return html
    .replace(/\n[ \t]*<(title|meta name="(description|robots|twitter:title|twitter:description)"|meta property="og:(title|description|url)"|link rel="canonical")[^\n]*/g, '')
    .replace(/<!-- static-content -->[\s\S]*?<!-- \/static-content -->/, '');
}

const HOSTILE_TITLE = `"><script>alert(1)</script></title><meta name='x'>\n\tnext line & more`;
const HOSTILE_SUMMARY = `Summary with "double" and 'single' quotes, <b>tags</b>, </title>, a\nnewline and ${'long text '.repeat(40)}`;

test('the site name, origin and default description match the web app', () => {
  assert.equal(/export const SITE_ORIGIN = '([^']+)';/.exec(pagesTs)?.[1], SITE_ORIGIN);
  assert.equal(/export const SITE_NAME = '([^']+)';/.exec(pagesTs)?.[1], SITE_NAME);
  assert.ok(pagesTs.replace(/\s+/g, ' ').includes(`'${DEFAULT_DESCRIPTION}'`), 'DEFAULT_DESCRIPTION matches pages.ts');
  assert.equal(documentTitle('Projects'), 'Projects | Atlas Relay');
});

test('escapeHtml escapes every character that can end text or an attribute', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
});

test('oneLine turns newlines, tabs and control characters into single spaces', () => {
  assert.equal(oneLine('  a\n\n b\t\tc\r\nd\x00e\x7f f  '), 'a b c d e f');
});

test('clip leaves short text alone and cuts long text at a word, with an ellipsis', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('exactly10!', 10), 'exactly10!');
  const cut = clip('one two three four five six seven eight nine ten', 20);
  assert.ok(Array.from(cut).length <= 20, cut);
  assert.equal(cut, 'one two three four…');
  // No space in the last fifth: cut mid-word rather than throw most of the text away.
  assert.equal(clip('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghi…');
});

test('clip counts graphemes, so it never splits an emoji, a flag or an accented letter', () => {
  const segments = (s: string): string[] => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s), (g) => g.segment);
  for (const unit of ['😀', '👨‍👩‍👧‍👦', '🇳🇱', 'e\u0301']) {
    const cut = clip(unit.repeat(30), 10);
    assert.deepEqual(segments(cut), [...Array(9).fill(unit), '…'], unit);
  }
});

test('the project head is one line, capped, and never empty', () => {
  const head = projectHead({ title: HOSTILE_TITLE, summary: HOSTILE_SUMMARY });
  assert.ok(!head.title.includes('\n') && !head.description.includes('\n'));
  assert.ok(Array.from(head.title).length <= TITLE_MAX);
  assert.ok(Array.from(head.description).length <= DESCRIPTION_MAX);
  assert.ok(head.description.endsWith('…'));
  assert.deepEqual(projectHead({ title: ' \n ', summary: '' }), { title: 'Research project', description: DEFAULT_DESCRIPTION });
  const long = projectHead({ title: 'x'.repeat(500), summary: 'ok' });
  assert.equal(Array.from(long.title).length, TITLE_MAX);
});

test('only /projects/{id} and /projects/{id}/edit with a well-formed id are project paths', () => {
  const origin = 'https://www.atlasrelay.org';
  assert.deepEqual(parseProjectPath(`${origin}/projects/${ID}`), { kind: 'project', id: ID });
  assert.deepEqual(parseProjectPath(`${origin}/projects/${ID}?utm_source=x#top`), { kind: 'project', id: ID });
  assert.deepEqual(parseProjectPath(`${origin}/projects/${ID}/`), { kind: 'project', id: ID });
  assert.deepEqual(parseProjectPath(`/projects/${ID}`), { kind: 'project', id: ID });
  assert.deepEqual(parseProjectPath(`https://atlasrelay.org/projects/${ID}`), { kind: 'project', id: ID });
  assert.deepEqual(parseProjectPath(`${origin}/projects/${ID}/edit`), { kind: 'edit', id: ID });
  assert.deepEqual(parseProjectPath(`${origin}/projects/${ID}/edit/`), { kind: 'edit', id: ID });
  for (const bad of [
    `${origin}/projects/${ID.toUpperCase()}`,
    `${origin}/projects/new`,
    `${origin}/projects/short`,
    `${origin}/projects/${'a'.repeat(33)}`,
    `${origin}/projects/${ID}/pledges`,
    `${origin}/projects/${ID}/edit/more`,
    `${origin}/projects/${ID}%2Fedit`,
    `${origin}/projects/..%2F..%2Fapi`,
    `${origin}/projects/%3Cscript%3E`,
    `${origin}/projects/${ID}%00`,
    `${origin}/projects//${ID}`,
    `${origin}/projects`,
    `${origin}/projects/`,
    `${origin}/api/project-page`,
    `${origin}/projectsx/${ID}`,
    'http://[not a url',
    '',
  ]) {
    assert.deepEqual(parseProjectPath(bad), { kind: 'none' }, bad);
  }
});

test('a project page carries the project in every title and description tag, escaped', () => {
  const html = renderProjectPage(template, { id: ID, title: HOSTILE_TITLE, summary: HOSTILE_SUMMARY });
  const head = projectHead({ title: HOSTILE_TITLE, summary: HOSTILE_SUMMARY });
  const title = documentTitle(head.title);
  assert.deepEqual(titles(html).map(unescape), [title]);
  assert.equal(unescape(meta(html, 'property', 'og:title')!), title);
  assert.equal(unescape(meta(html, 'name', 'twitter:title')!), title);
  assert.equal(unescape(meta(html, 'name', 'description')!), head.description);
  assert.equal(unescape(meta(html, 'property', 'og:description')!), head.description);
  assert.equal(unescape(meta(html, 'name', 'twitter:description')!), head.description);
  // Nothing the owner wrote gets out of its text or attribute.
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes("<meta name='x'>"));
  assert.equal(html.match(/<\/title>/g)?.length, 1);
  assert.equal(html.match(/<b>/g), null);
});

test('a project page has its canonical URL and og:url, is indexable, and keeps the share image', () => {
  const html = renderProjectPage(template, { id: ID, title: 'Anycast', summary: 'Measuring anycast.' });
  assert.deepEqual(canonicals(html), [`https://www.atlasrelay.org/projects/${ID}`]);
  assert.equal(meta(html, 'property', 'og:url'), `https://www.atlasrelay.org/projects/${ID}`);
  assert.equal(meta(html, 'name', 'robots'), undefined);
  assert.equal(meta(html, 'property', 'og:image'), 'https://www.atlasrelay.org/og-image.png');
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta(html, 'property', 'og:type'), 'website');
  assert.ok(!/\n[ \t]*\n/.test(html.slice(0, html.indexOf('</head>'))), 'no blank lines in the head');
});

test('a project page shows the title and summary as plain text inside #root', () => {
  const html = renderProjectPage(template, { id: ID, title: HOSTILE_TITLE, summary: HOSTILE_SUMMARY });
  const text = root(html);
  assert.equal(text.match(/<h1>/g)?.length, 1);
  assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'one h1 on the page');
  const h1 = unescape(/<h1>([^<]*)<\/h1>/.exec(text)![1]);
  const p = unescape(/<p>([^<]*)<\/p>/.exec(text)![1]);
  assert.equal(h1, projectHead({ title: HOSTILE_TITLE, summary: '' }).title);
  assert.ok(Array.from(p).length <= ROOT_TEXT_MAX);
  assert.ok(p.startsWith('Summary with "double" and \'single\' quotes, <b>tags</b>, </title>, a newline'));
});

test('everything outside the tags the renderer owns is left exactly as the template had it', () => {
  const html = renderProjectPage(template, { id: ID, title: HOSTILE_TITLE, summary: HOSTILE_SUMMARY });
  assert.equal(untouched(html), untouched(template));
  assert.ok(html.includes('<script type="module" src="/src/main.tsx"></script>'));
});

test('a title or summary with replacement patterns is inserted literally', () => {
  const html = renderProjectPage(template, { id: ID, title: "$& $' $` $1", summary: '$$ $<name>' });
  assert.ok(html.includes("<title>$&amp; $&#39; $` $1 | Atlas Relay</title>"));
  assert.ok(html.includes('content="$$ $&lt;name&gt;"'));
});

test('the edit form is kept out of search results and names no project', () => {
  const html = renderEditPage(template);
  assert.deepEqual(titles(html), ['Edit project | Atlas Relay']);
  assert.equal(meta(html, 'name', 'robots'), 'noindex');
  assert.deepEqual(canonicals(html), []);
  assert.equal(meta(html, 'property', 'og:url'), undefined);
  assert.equal(meta(html, 'name', 'description'), escapeHtml(DEFAULT_DESCRIPTION));
});

test('the fallback is the template with noindex added once', () => {
  const html = renderFallbackPage(template);
  assert.equal(metaAll(html, 'name', 'robots').length, 1);
  assert.equal(meta(html, 'name', 'robots'), 'noindex');
  assert.equal(html.replace(/\n[ \t]*<meta name="robots" content="noindex" \/>/, ''), template);
  assert.equal(renderFallbackPage(html), html);
});

test('a template that lost a tag fails instead of rendering a page without it', () => {
  assert.throws(() => renderProjectPage(template.replace(/<meta property="og:title"[^>]*>/, ''), { id: ID, title: 't', summary: 's' }), /og:title/);
  assert.throws(() => renderProjectPage(template.replace('<!-- static-content -->', ''), { id: ID, title: 't', summary: 's' }), /static root/);
});
