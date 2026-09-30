// The Application Insights SDK, loaded on demand by telemetry.ts once the page is idle, so none of
// it is in the bundle that renders the page. Only the parts in use are imported: the core, the
// sender, page views, custom events and exceptions (analytics), and fetch tracking (dependencies). The full
// @microsoft/applicationinsights-web package would add remote configuration, SDK usage stats and
// the cookie-based user and session plugin, none of which this site wants.
import { AppInsightsCore, DEFAULT_BREEZE_PATH, addPageHideEventListener, parseConnectionString, type IConfig, type IConfiguration, type ITelemetryItem } from '@microsoft/applicationinsights-core-js';
import { Sender } from '@microsoft/applicationinsights-channel-js';
import { AnalyticsPlugin } from '@microsoft/applicationinsights-analytics-js';
import { AjaxPlugin } from '@microsoft/applicationinsights-dependencies-js';
import { routeName, scrubItem, stripQuery } from './telemetry-scrub';

const ROLE = 'web';

let analytics: AnalyticsPlugin | null = null;
let channel: Sender | null = null;

export function init(connectionString: string, earlyErrors: unknown[]): void {
  const cs = parseConnectionString(connectionString);
  if (!cs.instrumentationkey || !cs.ingestionendpoint) return;
  const pageLoadId = Math.random().toString(36).slice(2, 12);
  const core = new AppInsightsCore();
  const plugin = new AnalyticsPlugin();
  const config: IConfiguration & IConfig = {
    instrumentationKey: cs.instrumentationkey,
    endpointUrl: `${cs.ingestionendpoint}${DEFAULT_BREEZE_PATH}`,
    // Nothing is written to the visitor's browser: no cookies, no local or session storage.
    disableCookiesUsage: true,
    isStorageUseDisabled: true,
    enableSessionStorageBuffer: false,
    // Page views are sent by telemetry.ts on each route change, with the query string removed.
    enableAutoRouteTracking: false,
    autoTrackPageVisitTime: false,
    disableExceptionTracking: false,
    enableUnhandledPromiseRejectionTracking: true,
    // The site calls its API with fetch. Only the method, URL and status are recorded (never a
    // request or response body, never a header), and the W3C traceparent header ties each call to
    // the API request it caused. Same origin only: no header goes to any other site.
    disableAjaxTracking: true,
    disableFetchTracking: false,
    enableRequestHeaderTracking: false,
    enableResponseHeaderTracking: false,
    enableAjaxErrorStatusText: false,
    enableCorsCorrelation: false,
    maxAjaxCallsPerView: 50,
  };
  const sender = new Sender();
  core.initialize(config, [plugin, new AjaxPlugin(), sender]);
  // The Sender batches for up to 15 seconds. The full SDK flushes the batch when the page is hidden
  // or left; with the core used directly that is this file's job. Without it, whatever was queued
  // when the visitor closed the tab was lost. A sign-in click does not rely on this: telemetry.ts
  // sends it before following the link. pagehide and visibilitychange only: an unload handler
  // would keep the page out of the back/forward cache.
  addPageHideEventListener(() => sender.onunloadFlush());
  channel = sender;
  core.addTelemetryInitializer((item: ITelemetryItem) => {
    scrubItem(item as Parameters<typeof scrubItem>[0], ROLE, pageLoadId);
  });
  analytics = plugin;
  for (const err of earlyErrors) trackError(err);
}

export function pageView(pathname: string, properties: Record<string, string>): void {
  analytics?.trackPageView({ name: routeName(pathname), uri: stripQuery(`${location.origin}${pathname}`), properties });
}

export function event(name: string, properties: Record<string, string>): void {
  analytics?.trackEvent({ name, properties });
}

/** Send what is queued now, the way it is sent when the page is left (a beacon where possible). */
export function flush(): void {
  channel?.onunloadFlush();
}

/**
 * Send what is queued now as a keepalive request, which the browser finishes even after the page
 * has been replaced, and resolve once it has finished or failed. Never rejects; the caller decides
 * how long to wait. Resolves at once when nothing was queued, or when the SDK used a beacon
 * instead (browsers without keepalive, or a batch over the keepalive size limit), since a beacon
 * outlives the page too.
 */
export function sendNow(): Promise<void> {
  const sender = channel;
  if (!sender) return Promise.resolve();
  // The unload path makes one call to the global fetch, with keepalive, and does not wait for the
  // response. Catch that call's promise so the caller can.
  let request: Promise<Response> | undefined;
  const original = window.fetch;
  window.fetch = (...args: Parameters<typeof fetch>) => (request = original.apply(window, args));
  try {
    sender.onunloadFlush();
  } catch {
    // Nothing was sent; the caller goes on regardless.
  } finally {
    window.fetch = original;
  }
  const started = request as Promise<Response> | undefined;
  return started ? started.then(() => undefined, () => undefined) : Promise.resolve();
}

function trackError(err: unknown): void {
  const exception = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-Error value thrown');
  analytics?.trackException({ exception });
}
