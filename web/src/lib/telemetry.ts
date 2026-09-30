import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { campaignFrom, linkAction, referrerOrigin, routeName } from './telemetry-scrub';

/**
 * Browser telemetry: page views (one per route), uncaught errors and unhandled promise rejections,
 * page load timings, the API calls each page makes, and a few named actions (trackAction). Sent to
 * the same Application Insights resource as the API.
 *
 * Each page view says how the visitor arrived: `referrerOrigin` is the referring site's origin,
 * "direct" or "internal", and utm_source, utm_medium and utm_campaign from the landing URL ride
 * along on every page view of that page load. docs/RUNBOOK.md, "Traffic", says how to read them.
 *
 * Off unless the build is given VITE_APPINSIGHTS_CONNECTION_STRING, so local and dev builds send
 * nothing. The production build gets it from the repository variable APPINSIGHTS_CONNECTION_STRING
 * (.github/workflows/deploy.yml), which scripts/bootstrap.sh sets from the Bicep output.
 *
 * The SDK itself (./telemetry-sdk) is loaded after the page has finished loading and the browser
 * is idle. Page views and errors from before that are held here and sent once it arrives.
 * What may be sent is decided in ./telemetry-scrub.
 */

const CONNECTION_STRING: string = import.meta.env.VITE_APPINSIGHTS_CONNECTION_STRING ?? '';
const MAX_HELD = 20;

type Sdk = typeof import('./telemetry-sdk');

/** The actions counted in the Traffic reports. Properties never carry anything about the person. */
export type Action = 'pledge-started' | 'pledge-completed' | 'project-posted' | 'sign-in-clicked' | 'outbound-click';

let sdk: Sdk | null = null;
let lastPath = '';
// The first page view of a page load carries how the browser arrived; route changes after it are
// navigation inside the site.
let nextReferrer = 'direct';
let campaign: Record<string, string> = {};
const held: ((mod: Sdk) => void)[] = [];
const heldErrors: unknown[] = [];

function holdError(event: ErrorEvent): void {
  if (heldErrors.length < MAX_HELD) heldErrors.push(event.error ?? event.message);
}

function holdRejection(event: PromiseRejectionEvent): void {
  if (heldErrors.length < MAX_HELD) heldErrors.push(event.reason);
}

function stopHolding(): void {
  window.removeEventListener('error', holdError);
  window.removeEventListener('unhandledrejection', holdRejection);
}

function whenIdle(fn: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 5000 });
  else setTimeout(fn, 2000);
}

function send(fn: (mod: Sdk) => void): void {
  if (sdk) fn(sdk);
  else if (held.length < MAX_HELD) held.push(fn);
}

// Sign-in links and links to atlas.ripe.net, wherever they are on the page. Middle clicks open a
// tab and count too.
function onLinkClick(event: MouseEvent): void {
  if (event.type === 'auxclick' && event.button !== 1) return;
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const action = linkAction(anchor.href, location.href);
  if (action) trackAction(action.name, action.properties);
}

/** Call once, before the app renders. */
export function startTelemetry(): void {
  if (!CONNECTION_STRING) return;
  // Read before the router can change the URL. The query string itself is never sent.
  campaign = campaignFrom(location.search);
  nextReferrer = referrerOrigin(document.referrer, location.hostname);
  document.addEventListener('click', onLinkClick, true);
  document.addEventListener('auxclick', onLinkClick, true);
  window.addEventListener('error', holdError);
  window.addEventListener('unhandledrejection', holdRejection);
  const load = () =>
    whenIdle(() => {
      import('./telemetry-sdk')
        .then((mod) => {
          // The SDK installs its own handlers for both events from here on.
          stopHolding();
          mod.init(CONNECTION_STRING, heldErrors.splice(0));
          sdk = mod;
          for (const fn of held.splice(0)) fn(mod);
        })
        .catch(() => {
          // A blocked or failed download costs the visitor nothing. Stop collecting for it.
          stopHolding();
          document.removeEventListener('click', onLinkClick, true);
          document.removeEventListener('auxclick', onLinkClick, true);
          held.length = 0;
          heldErrors.length = 0;
        });
    });
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
}

function trackPageView(pathname: string): void {
  if (!CONNECTION_STRING || pathname === lastPath) return;
  lastPath = pathname;
  const properties = { referrerOrigin: nextReferrer, ...campaign };
  nextReferrer = 'internal';
  send((mod) => mod.pageView(pathname, properties));
}

/**
 * Count an action. `page` (the route it happened on) is added here. Pass only public ids, fixed
 * strings and buckets; everything is scrubbed again on the way out (./telemetry-scrub).
 */
export function trackAction(name: Action, properties: Record<string, string> = {}): void {
  if (!CONNECTION_STRING) return;
  const withPage = { ...properties, page: routeName(location.pathname) };
  send((mod) => mod.event(name, withPage));
}

/** Sends a page view whenever the route changes. Render once inside the router. */
export function PageViews(): null {
  const { pathname } = useLocation();
  useEffect(() => trackPageView(pathname), [pathname]);
  return null;
}
