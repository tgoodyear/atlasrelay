// Page titles, descriptions and canonical URLs, shared by the build and the running app.
//
// The site is one React app, so every URL used to be answered with the same index.html and the
// same head. The build now writes one HTML file per kind of page from index.html (see
// vite.config.ts), and staticwebapp.config.json rewrites each route to its file, so crawlers that
// do not run JavaScript see the right title, description and canonical URL. Once the app is
// running, usePageMeta keeps the head in step as the visitor moves around.
//
// Nothing in this file may touch the DOM or Node APIs: vite.config.ts imports it at build time.

/** The one canonical host. atlasrelay.org serves the same site; see docs/RUNBOOK.md. */
export const SITE_ORIGIN = 'https://www.atlasrelay.org';
export const SITE_NAME = 'Atlas Relay';
export const DEFAULT_DESCRIPTION =
  'Atlas Relay connects Internet researchers who need RIPE Atlas measurement credits with Atlas users who have credits to share.';

export interface PageMeta {
  /** Shown before the site name in the tab. Empty means the site's home title. */
  title?: string;
  description?: string;
  /** Path of the canonical URL. Absent means no canonical tag and no og:url. */
  path?: string;
  /** Pages behind sign-in, and the not-found page, are kept out of search results. */
  noindex?: boolean;
}

export const HOME_TITLE = `${SITE_NAME} | Donate RIPE Atlas credits to measurement research`;

export function documentTitle(title?: string): string {
  return title ? `${title} | ${SITE_NAME}` : HOME_TITLE;
}

export function canonicalUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

const PROJECTS_TEXT = 'Internet measurement research looking for RIPE Atlas credits. Pick one and send what you can spare.';
const HOW_IT_WORKS_TEXT =
  'Atlas Relay is a donation board for RIPE Atlas credits. Nothing is bought or sold, and donors get nothing back. Credits move directly between RIPE Atlas accounts, and this site never holds credits or long-lived keys.';

/** What each page puts in the head. Project pages build theirs from the project itself. */
export const META = {
  home: { path: '/' },
  projects: { title: 'Projects', description: PROJECTS_TEXT, path: '/projects' },
  howItWorks: { title: 'How it works', description: HOW_IT_WORKS_TEXT, path: '/how-it-works' },
  // One file serves every project page, so it cannot name the project. It carries no canonical
  // tag rather than a wrong one: the app adds the project's own once it has loaded, and search
  // engines only accept a canonical added by script when the HTML did not declare one.
  project: { title: 'Research project' },
  // Pages that need a signed-in account. A crawler only ever sees a sign-in prompt on them.
  dashboard: { title: 'Dashboard', noindex: true },
  profile: { title: 'Your profile', noindex: true },
  newProject: { title: 'Post a project', noindex: true },
  editProject: { title: 'Edit project', noindex: true },
  signIn: { title: 'Sign in', noindex: true },
  notFound: { title: 'Page not found', noindex: true },
} satisfies Record<string, PageMeta>;

/**
 * The HTML files the build writes besides index.html, and the static text each one carries inside
 * #root until the app mounts. staticwebapp.config.json routes to these by file name, and the tests
 * check that every route in App.tsx lands on one of them.
 */
export interface Shell {
  file: string;
  meta: PageMeta;
  heading: string;
  body: string;
}

export const SHELLS: Shell[] = [
  { file: 'shell/projects.html', meta: META.projects, heading: 'Projects', body: PROJECTS_TEXT },
  { file: 'shell/how-it-works.html', meta: META.howItWorks, heading: 'How it works', body: HOW_IT_WORKS_TEXT },
  { file: 'shell/project.html', meta: META.project, heading: 'Research project', body: DEFAULT_DESCRIPTION },
  { file: 'shell/app.html', meta: META.signIn, heading: SITE_NAME, body: DEFAULT_DESCRIPTION },
  { file: '404.html', meta: META.notFound, heading: 'Page not found', body: 'There is no page at this address.' },
];

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Replace exactly one match, so a template edit that breaks a pattern fails the build. */
function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  const matches = html.match(new RegExp(pattern.source, 'g'));
  if (!matches || matches.length !== 1) {
    throw new Error(`index.html must contain exactly one ${what}; found ${matches ? matches.length : 0}`);
  }
  return html.replace(pattern, () => replacement);
}

const CANONICAL = /<link rel="canonical" href="[^"]*" \/>/;
const OG_URL = /<meta property="og:url" content="[^"]*" \/>/;
/** The same tag with its line break and indent, so removing it leaves no blank line. */
const withLine = (pattern: RegExp): RegExp => new RegExp(`\\n[ \\t]*${pattern.source}`);
// The text inside #root sits between these two comments. React replaces all of it on mount.
export const ROOT_START = '<!-- static-content -->';
export const ROOT_END = '<!-- /static-content -->';

/** Build one page's HTML from the built index.html, which carries the home page's head. */
export function renderShell(indexHtml: string, shell: Shell): string {
  const { meta } = shell;
  const title = escapeHtml(documentTitle(meta.title));
  const description = escapeHtml(meta.description ?? DEFAULT_DESCRIPTION);
  let html = indexHtml;
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`, '<title>');
  html = replaceOnce(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${description}" />`, 'meta description');
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`, 'og:title');
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${description}" />`, 'og:description');
  html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${title}" />`, 'twitter:title');
  html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${description}" />`, 'twitter:description');
  if (meta.path && !meta.noindex) {
    const url = escapeHtml(canonicalUrl(meta.path));
    html = replaceOnce(html, CANONICAL, `<link rel="canonical" href="${url}" />`, 'canonical link');
    html = replaceOnce(html, OG_URL, `<meta property="og:url" content="${url}" />`, 'og:url');
  } else {
    html = replaceOnce(html, withLine(CANONICAL), '', 'canonical link');
    html = replaceOnce(html, withLine(OG_URL), '', 'og:url');
  }
  if (meta.noindex) {
    const viewport = /<meta name="viewport" content="[^"]*" \/>/;
    const tag = html.match(viewport)?.[0] ?? '';
    html = replaceOnce(html, viewport, `${tag}\n    <meta name="robots" content="noindex" />`, 'viewport meta');
  }
  html = replaceOnce(
    html,
    new RegExp(`${ROOT_START}[\\s\\S]*?${ROOT_END}`),
    `${ROOT_START}\n      <div class="narrow">\n        <div class="page-head">\n          <h1>${escapeHtml(shell.heading)}</h1>\n          <p>${escapeHtml(shell.body)}</p>\n        </div>\n      </div>\n      ${ROOT_END}`,
    'static root content',
  );
  return html;
}
