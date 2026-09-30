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
 *
 * The functions at the end decide what telemetry.ts adds to page views and actions: three utm
 * values from the landing URL, the referring site's origin, a pledge size to the nearest power of
 * ten, and which sign-in and atlas.ripe.net links were followed.
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

// Browser pathnames stay percent-encoded, so "/someone%40example.org" or a key with "%2D"
// separators would slip past the patterns above. Decode single-byte escapes (up to three rounds,
// for double encoding) before matching. Multi-byte escapes are left as they are: none of the
// characters the patterns look for need one.
function decodeEscapes(text: string): string {
  let out = text;
  for (let i = 0; i < 3 && /%[0-7][0-9a-f]/i.test(out); i++) {
    out = out.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return out;
}

/** Replace keys, email addresses and query strings inside free text. */
export function scrubText(text: string): string {
  return decodeEscapes(text).replace(URL_IN_TEXT_RE, '$1').replace(UUID_RE, '[uuid]').replace(EMAIL_RE, '[email]');
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
  if (['/', '/projects', '/projects/new', '/dashboard', '/profile', '/how-it-works', '/privacy'].includes(path)) return path;
  if (/^\/projects\/[^/]+\/edit$/.test(path)) return '/projects/:id/edit';
  if (/^\/projects\/[^/]+$/.test(path)) return '/projects/:id';
  return '(not found)';
}

// ---------- where a visit came from, and what it did ----------

const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;
/** Longest campaign value kept, in characters, after redaction. */
export const CAMPAIGN_MAX = 64;

/**
 * The campaign a link was tagged with, from the landing URL's query string. Only utm_source,
 * utm_medium and utm_campaign are read, and each value is lowercased, redacted like any other
 * text here, stripped of control characters and cut to CAMPAIGN_MAX. The URL itself is still sent
 * without its query string.
 */
export function campaignFrom(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    // Control characters go first, so one cannot split a key that removing it would rejoin, and
    // redaction comes before the cut, so a cut cannot leave part of a key that no longer matches.
    const clean = scrubText(value.toLowerCase().replace(/[\x00-\x1f\x7f]/g, ''))
      .trim()
      .slice(0, CAMPAIGN_MAX)
      .trim();
    if (clean) out[key] = clean;
  }
  return out;
}

/**
 * How a page load arrived: "direct" when the browser gave no referrer, "internal" when it came from
 * this site (www and the bare domain count as one site), and otherwise the referring site's origin.
 * An app referrer such as android-app://com.google.android.gm keeps its scheme and host.
 */
export function referrerOrigin(referrer: string, siteHostname: string): string {
  if (!referrer) return 'direct';
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return 'unknown';
  }
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');
  if (url.hostname && bare(url.hostname) === bare(siteHostname)) return 'internal';
  if (url.protocol === 'http:' || url.protocol === 'https:') return scrubText(url.origin);
  return url.hostname ? scrubText(`${url.protocol}//${url.hostname}`) : 'unknown';
}

/**
 * A pledge's size to the nearest power of ten. Pledges are public, amount, date and message next
 * to the donor's name, so an exact amount would pick out one pledge row.
 */
export function amountBucket(credits: number): string {
  if (!Number.isFinite(credits) || credits < 1) return 'unknown';
  if (credits < 1_000) return '1-999';
  if (credits < 10_000) return '1000-9999';
  if (credits < 100_000) return '10000-99999';
  if (credits < 1_000_000) return '100000-999999';
  return '1000000+';
}

export type LinkAction =
  | { name: 'sign-in-clicked'; properties: { provider: string } }
  | { name: 'outbound-click'; properties: { host: string; path: string } };

/**
 * Whether following a link is an action worth counting: a sign-in link (/.auth/login/<provider>
 * on this site), or a link to atlas.ripe.net. For the latter the path keeps at most three
 * segments, with numbers (probe and measurement ids) replaced, and no query string.
 */
export function linkAction(href: string, pageHref: string): LinkAction | null {
  let url: URL;
  let page: URL;
  try {
    url = new URL(href, pageHref);
    page = new URL(pageHref);
  } catch {
    return null;
  }
  if (url.origin === page.origin) {
    const m = /^\/\.auth\/login\/([a-z0-9-]{1,20})\/?$/i.exec(url.pathname);
    return m ? { name: 'sign-in-clicked', properties: { provider: m[1].toLowerCase() } } : null;
  }
  if (url.hostname.toLowerCase() === 'atlas.ripe.net') {
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .map((s) => (/^\d+$/.test(s) ? ':n' : s.toLowerCase()));
    const path = scrubText(`/${segments.join('/')}`).slice(0, CAMPAIGN_MAX);
    return { name: 'outbound-click', properties: { host: 'atlas.ripe.net', path } };
  }
  return null;
}
