// The Application Insights SDK, loaded on demand by telemetry.ts once the page is idle, so none of
// it is in the bundle that renders the page. Only the parts in use are imported: the core, the
// sender, page views and exceptions (analytics), and fetch tracking (dependencies). The full
// @microsoft/applicationinsights-web package would add remote configuration, SDK usage stats and
// the cookie-based user and session plugin, none of which this site wants.
import { AppInsightsCore, DEFAULT_BREEZE_PATH, parseConnectionString, type IConfig, type IConfiguration, type ITelemetryItem } from '@microsoft/applicationinsights-core-js';
import { Sender } from '@microsoft/applicationinsights-channel-js';
import { AnalyticsPlugin } from '@microsoft/applicationinsights-analytics-js';
import { AjaxPlugin } from '@microsoft/applicationinsights-dependencies-js';
import { routeName, scrubItem, stripQuery } from './telemetry-scrub';

const ROLE = 'web';

let analytics: AnalyticsPlugin | null = null;

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
  core.initialize(config, [plugin, new AjaxPlugin(), new Sender()]);
  core.addTelemetryInitializer((item: ITelemetryItem) => {
    scrubItem(item as Parameters<typeof scrubItem>[0], ROLE, pageLoadId);
  });
  analytics = plugin;
  for (const err of earlyErrors) trackError(err);
}

export function pageView(pathname: string): void {
  analytics?.trackPageView({ name: routeName(pathname), uri: stripQuery(`${location.origin}${pathname}`) });
}

function trackError(err: unknown): void {
  const exception = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-Error value thrown');
  analytics?.trackException({ exception });
}
