import { isId } from './ids';
import { SITE_NAME, SITE_ORIGIN } from './site';

// The HTML for /projects/{id}, built on the server so link previews and crawlers see the project.
//
// The template is the project shell the web build writes (web/dist/shell/project.html, see
// web/src/lib/pages.ts), embedded in the API bundle by api/bundle.mjs. Everything here replaces a
// few head tags and the static text inside #root and leaves every other byte of the template
// alone, so the page loads the same scripts and styles as any other page of the same deploy.
//
// This file imports only ids.ts and site.ts: web/test/seo.test.ts loads it to check the renderer
// against the real shell.

/** Longest title kept, in characters. The API refuses longer ones; this covers rows written before. */
export const TITLE_MAX = 120;
/** Longest meta and og:description. Search results and link previews cut well before this. */
export const DESCRIPTION_MAX = 200;
/** Longest summary shown inside #root. The API refuses summaries over 280 characters. */
export const ROOT_TEXT_MAX = 300;

export const DEFAULT_DESCRIPTION =
  'Atlas Relay connects Internet researchers who need RIPE Atlas measurement credits with Atlas users who have credits to share.';

/** Escape for HTML text and for a double- or single-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line of text: control characters and runs of whitespace become a single space. */
export function oneLine(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim();
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Cut to at most `max` characters, counted as graphemes (what a reader sees as one character), so
 * a cut never splits an emoji, a flag or a letter with combining accents. A cut ends at the last
 * space in the final fifth when there is one, and gets an ellipsis.
 */
export function clip(value: string, max: number): string {
  const chars = Array.from(graphemes.segment(value), (g) => g.segment);
  if (chars.length <= max) return value;
  let cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  if (space >= Math.floor(max * 0.8)) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

export interface Head {
  /** Shown before " | Atlas Relay". Empty means the site's home title. */
  title: string;
  description: string;
}

export function documentTitle(title: string): string {
  return `${title} | ${SITE_NAME}`;
}

/**
 * The title and description of a project page. GET /api/projects/{id} returns this as `page`, and
 * the app's usePageMeta uses it as is, so the head the app sets after loading is the head this
 * server sent and nothing changes when the app mounts.
 */
export function projectHead(p: { title: string; summary: string }): Head {
  return {
    title: clip(oneLine(p.title), TITLE_MAX) || 'Research project',
    description: clip(oneLine(p.summary), DESCRIPTION_MAX) || DEFAULT_DESCRIPTION,
  };
}

export function projectUrl(id: string): string {
  return `${SITE_ORIGIN}/projects/${id}`;
}

/** What a path under /projects/ asks for. */
export type ProjectPath = { kind: 'project'; id: string } | { kind: 'edit'; id: string } | { kind: 'none' };

// Exactly /projects/{id} or /projects/{id}/edit, with the optional trailing slash SWA ignores when
// it matches routes. isId then checks the id itself. Nothing is decoded first, so an encoded
// slash or dot stays literal and fails the check.
const PROJECT_PATH = /^\/projects\/([^/]+)(\/edit)?\/?$/;

/**
 * Read the page asked for from the URL SWA was sent, which it passes in x-ms-original-url because
 * a route rewrite cannot carry path segments to the function. The header holds the full URL; a
 * bare path is accepted too. Anything that is not a well-formed project path is `none`.
 */
export function parseProjectPath(originalUrl: string): ProjectPath {
  let pathname: string;
  try {
    pathname = new URL(originalUrl, SITE_ORIGIN).pathname;
  } catch {
    return { kind: 'none' };
  }
  const m = PROJECT_PATH.exec(pathname);
  if (!m || !isId(m[1])) return { kind: 'none' };
  return m[2] ? { kind: 'edit', id: m[1] } : { kind: 'project', id: m[1] };
}

/** Replace exactly one match, so a template that no longer has a tag fails instead of shipping without it. */
function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  const count = html.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
  if (count !== 1) throw new Error(`the page template must contain exactly one ${what}; found ${count}`);
  return html.replace(pattern, () => replacement);
}

/** Remove a tag, with its line break and indent, when it is there. */
function removeLine(html: string, pattern: RegExp): string {
  return html.replace(new RegExp(`\\n[ \\t]*${pattern.source}`, 'g'), '');
}

const TITLE = /<title>[^<]*<\/title>/;
const DESCRIPTION = /<meta name="description" content="[^"]*" \/>/;
const OG_TITLE = /<meta property="og:title" content="[^"]*" \/>/;
const OG_DESCRIPTION = /<meta property="og:description" content="[^"]*" \/>/;
const TWITTER_TITLE = /<meta name="twitter:title" content="[^"]*" \/>/;
const TWITTER_DESCRIPTION = /<meta name="twitter:description" content="[^"]*" \/>/;
const CANONICAL = /<link rel="canonical" href="[^"]*" \/>/;
const OG_URL = /<meta property="og:url" content="[^"]*" \/>/;
const ROBOTS = /<meta name="robots" content="[^"]*" \/>/;
const VIEWPORT = /<meta name="viewport" content="[^"]*" \/>/;
// The same markers as web/src/lib/pages.ts. React replaces everything between them on mount.
const ROOT = /<!-- static-content -->[\s\S]*?<!-- \/static-content -->/;

export interface PageOptions {
  head: Head;
  /** The canonical URL. Absent means no canonical tag and no og:url. */
  url?: string;
  noindex?: boolean;
  /** The static text inside #root: a heading and one paragraph. */
  heading: string;
  body: string;
}

/**
 * Put a page's head and #root text into the template. Every value is escaped here, so callers pass
 * plain text, including text a project owner wrote.
 */
export function renderPage(template: string, page: PageOptions): string {
  const title = escapeHtml(documentTitle(page.head.title));
  const description = escapeHtml(page.head.description);
  let html = template;
  html = replaceOnce(html, TITLE, `<title>${title}</title>`, '<title>');
  html = replaceOnce(html, OG_TITLE, `<meta property="og:title" content="${title}" />`, 'og:title');
  html = replaceOnce(html, TWITTER_TITLE, `<meta name="twitter:title" content="${title}" />`, 'twitter:title');
  html = replaceOnce(html, TWITTER_DESCRIPTION, `<meta name="twitter:description" content="${description}" />`, 'twitter:description');
  // The project shell has no canonical, og:url or robots tag, and the 404 page has robots. Remove
  // whatever is there, then add what this page needs, so one renderer works on either.
  html = removeLine(html, CANONICAL);
  html = removeLine(html, OG_URL);
  html = removeLine(html, ROBOTS);
  const pad = '\n    ';
  const url = page.url ? escapeHtml(page.url) : '';
  html = replaceOnce(
    html,
    DESCRIPTION,
    `<meta name="description" content="${description}" />${url ? `${pad}<link rel="canonical" href="${url}" />` : ''}`,
    'meta description',
  );
  html = replaceOnce(
    html,
    OG_DESCRIPTION,
    `<meta property="og:description" content="${description}" />${url ? `${pad}<meta property="og:url" content="${url}" />` : ''}`,
    'og:description',
  );
  if (page.noindex) {
    const viewport = html.match(VIEWPORT)?.[0] ?? '';
    html = replaceOnce(html, VIEWPORT, `${viewport}${pad}<meta name="robots" content="noindex" />`, 'viewport meta');
  }
  html = replaceOnce(
    html,
    ROOT,
    `<!-- static-content -->\n      <div class="narrow">\n        <div class="page-head">\n          <h1>${escapeHtml(page.heading)}</h1>\n          <p>${escapeHtml(page.body)}</p>\n        </div>\n      </div>\n      <!-- /static-content -->`,
    'static root content',
  );
  return html;
}

/** A public project's page: its own title, summary and canonical URL, indexable. */
export function renderProjectPage(template: string, project: { id: string; title: string; summary: string }): string {
  const head = projectHead(project);
  return renderPage(template, {
    head,
    url: projectUrl(project.id),
    heading: head.title,
    body: clip(oneLine(project.summary), ROOT_TEXT_MAX) || DEFAULT_DESCRIPTION,
  });
}

/** The edit form. It needs sign-in, so it is kept out of search results, as the app does. */
export function renderEditPage(template: string): string {
  return renderPage(template, {
    head: { title: 'Edit project', description: DEFAULT_DESCRIPTION },
    noindex: true,
    heading: 'Edit project',
    body: DEFAULT_DESCRIPTION,
  });
}

/**
 * The project shell as the build wrote it, plus noindex: served when the project could not be
 * read, so the app still loads and fetches the project itself, and a crawler that caught the
 * outage does not index a page with no project on it.
 */
export function renderFallbackPage(template: string): string {
  if (ROBOTS.test(template)) return template;
  const viewport = template.match(VIEWPORT)?.[0] ?? '';
  return replaceOnce(template, VIEWPORT, `${viewport}\n    <meta name="robots" content="noindex" />`, 'viewport meta');
}
