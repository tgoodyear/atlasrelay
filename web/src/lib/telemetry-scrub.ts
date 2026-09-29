/**
 * What the browser is allowed to send to Application Insights. Pure functions, so
 * web/test/telemetry.test.ts can run them without a browser.
 *
 * Every telemetry item passes through scrubItem before it leaves the page:
 * - URLs lose their query string and fragment. Search terms and anything a link might carry in
 *   either never leave the browser.
 * - The referrer is cut to its origin, so another site's path and query are not recorded.
 * - Every other string, exception messages and stacks included, has anything shaped like a UUID
 *   (every RIPE Atlas API key is one; this site's own ids are not) or an email address replaced.
 * - Any user id or account id the SDK might add is removed. The site never sets one.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// A URL inside free text, absolute or root-relative ("/api/projects?q=..."), up to the first
// character that cannot be part of it.
const URL_IN_TEXT_RE = /(https?:\/\/[^\s?#"'<>]*|(?<![\w/.])\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

/** Drop the query string and fragment from a URL or a path. */
export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/** Replace keys, email addresses and query strings inside free text. */
export function scrubText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, '$1').replace(UUID_RE, '[uuid]').replace(EMAIL_RE, '[email]');
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// Fields that hold a URL or a path (page views, dependencies, exceptions). The dependency `name`
// is "GET /api/projects?q=..." and `data` the full URL, so both are cut at the query too.
const URL_FIELDS = new Set(['uri', 'url', 'target', 'data', 'name']);
const REFERRER_FIELDS = new Set(['refUri', 'referrer']);
const DROPPED_TAGS = ['ai.user.id', 'ai.user.authUserId', 'ai.user.accountId'];

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (REFERRER_FIELDS.has(key)) return origin(value);
    return scrubText(URL_FIELDS.has(key) ? stripQuery(value) : value);
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubValue(key, value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const k of Object.keys(record)) record[k] = scrubValue(k, record[k], depth + 1);
  return value;
}

export interface TelemetryItemLike {
  baseData?: Record<string, unknown>;
  data?: Record<string, unknown>;
  tags?: Record<string, unknown> | unknown[];
}

/** Telemetry initializer: edits the item in place. Never drops it. */
export function scrubItem(item: TelemetryItemLike, role: string, pageLoadId: string): void {
  if (item.baseData) scrubValue('baseData', item.baseData, 0);
  if (item.data) scrubValue('data', item.data, 0);
  if (!item.tags || Array.isArray(item.tags)) item.tags = {};
  const tags = item.tags as Record<string, unknown>;
  for (const t of DROPPED_TAGS) delete tags[t];
  if (typeof tags['ai.operation.name'] === 'string') tags['ai.operation.name'] = stripQuery(tags['ai.operation.name'] as string);
  for (const t of Object.keys(tags)) if (typeof tags[t] === 'string') tags[t] = scrubText(tags[t] as string);
  tags['ai.cloud.role'] = role;
  // No cookies and no storage, so there is no session to join. A random id per page load groups
  // one visit's page views, API calls and errors, and is gone when the tab closes.
  tags['ai.session.id'] = pageLoadId;
}

/**
 * The route a path belongs to, for page view names. Matches the routes in src/App.tsx; the test
 * reads that file to keep the two in step. Ids are replaced so a page view name counts visits to
 * the page, not to one project.
 */
export function routeName(pathname: string): string {
  // React Router matches routes without regard to case, so /Projects is the projects page.
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (['/', '/projects', '/projects/new', '/dashboard', '/profile', '/how-it-works'].includes(path)) return path;
  if (/^\/projects\/[^/]+\/edit$/.test(path)) return '/projects/:id/edit';
  if (/^\/projects\/[^/]+$/.test(path)) return '/projects/:id';
  return '(not found)';
}
