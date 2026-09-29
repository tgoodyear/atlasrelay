import { parseProjectPath, renderEditPage, renderFallbackPage, renderProjectPage } from './projectHtml';
import type { Project } from './store';
import { logError, logEvent } from './telemetry';
import { isPublicProject } from './views';

/** The two pages the web build writes that this function starts from. See api/bundle.mjs. */
export interface PageTemplates {
  /** web/dist/shell/project.html */
  project: string;
  /** web/dist/404.html */
  notFound: string;
}

export interface PageResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * The headers staticwebapp.config.json sets in globalHeaders. SWA does not add those to anything a
 * function returns, so an HTML page served from here has to carry them itself.
 * Strict-Transport-Security is left out: SWA adds that one to every response, this included.
 * test/projectPage.test.ts checks this list against the config.
 */
export const PAGE_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.in.applicationinsights.azure.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * How long a browser or proxy may reuse a project page or a 404. Short, because an owner's edit
 * should show up in a new link preview soon, and because the page names this deploy's script
 * files, which the next deploy removes. The static pages use 30 seconds for the same reason.
 */
export const PAGE_MAX_AGE = 60;

function html(status: number, body: string, extra: Record<string, string>): PageResponse {
  return { status, body, headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS, ...extra } };
}

const CACHED = { 'cache-control': `public, max-age=${PAGE_MAX_AGE}` };
const NOINDEX = { 'x-robots-tag': 'noindex' };

function fallback(templates: PageTemplates): PageResponse {
  let body = templates.project;
  try {
    body = renderFallbackPage(templates.project);
  } catch {
    // The x-robots-tag header below still keeps the page out of search results.
  }
  return html(200, body, { 'cache-control': 'no-store', ...NOINDEX });
}

/**
 * The response for a request that SWA rewrote from /projects/* to this function.
 *
 * - /projects/{id} for a project anyone may see: 200, the project's own head, indexable.
 * - /projects/{id}/edit: 200, the edit form's head, noindex. Nothing is read: the form needs
 *   sign-in and loads the project itself.
 * - anything else under /projects/, a malformed id, or a project that does not exist or was taken
 *   down: 404 with the site's 404 page.
 * - storage failing, or no original URL to read the id from: 200 with the generic project shell,
 *   noindex and not cached, so the app still loads and can show the project once storage answers.
 *
 * `load` is getProject in production and a stub in the tests.
 */
export async function projectPageResponse(
  originalUrl: string | null | undefined,
  load: (id: string) => Promise<Project | null>,
  templates: PageTemplates,
): Promise<PageResponse> {
  if (!originalUrl) {
    // SWA sets this header on every rewritten request. Without it the id is unknown; the generic
    // shell keeps the page working, and the log line says why the heads are generic.
    logEvent('project-page', { outcome: 'no-original-url' }, 'warn');
    return fallback(templates);
  }
  const path = parseProjectPath(originalUrl);
  if (path.kind === 'none') return html(404, templates.notFound, { ...CACHED, ...NOINDEX });
  try {
    if (path.kind === 'edit') return html(200, renderEditPage(templates.project), { ...CACHED, ...NOINDEX });
    let project: Project | null;
    try {
      project = await load(path.id);
    } catch (err) {
      logError('Project page: could not read the project', err);
      return fallback(templates);
    }
    if (!project || !isPublicProject(project)) return html(404, templates.notFound, { ...CACHED, ...NOINDEX });
    return html(200, renderProjectPage(templates.project, project), CACHED);
  } catch (err) {
    // Only a template the renderer no longer recognises gets here; the tests render the real one.
    logError('Project page: could not render the template', err);
    return fallback(templates);
  }
}
