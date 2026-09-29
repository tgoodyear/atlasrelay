import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Browser telemetry: page views (one per route), uncaught errors and unhandled promise rejections,
 * page load timings, and the API calls each page makes. Sent to the same Application Insights
 * resource as the API.
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

let sdk: Sdk | null = null;
let lastPath = '';
const heldPages: string[] = [];
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

/** Call once, before the app renders. */
export function startTelemetry(): void {
  if (!CONNECTION_STRING) return;
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
          for (const path of heldPages.splice(0)) mod.pageView(path);
        })
        .catch(() => {
          // A blocked or failed download costs the visitor nothing. Stop collecting for it.
          stopHolding();
          heldPages.length = 0;
          heldErrors.length = 0;
        });
    });
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
}

function trackPageView(pathname: string): void {
  if (!CONNECTION_STRING || pathname === lastPath) return;
  lastPath = pathname;
  if (sdk) sdk.pageView(pathname);
  else if (heldPages.length < MAX_HELD) heldPages.push(pathname);
}

/** Sends a page view whenever the route changes. Render once inside the router. */
export function PageViews(): null {
  const { pathname } = useLocation();
  useEffect(() => trackPageView(pathname), [pathname]);
  return null;
}
