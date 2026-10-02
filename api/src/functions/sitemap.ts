import { app, type HttpResponseInit } from '@azure/functions';
import { API_SECURITY_HEADERS } from '../lib/http';
import { logError } from '../lib/telemetry';
import { sitemapEntries, sitemapXml } from '../lib/sitemap';
import { listProjects } from '../lib/store';

// Served at /sitemap.xml: staticwebapp.config.json rewrites that path to this function, so the
// sitemap lists every public project without a rebuild. Read-only, and it publishes only URLs.
app.http('sitemap', {
  route: 'sitemap',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (): Promise<HttpResponseInit> => {
    try {
      const xml = sitemapXml(sitemapEntries(await listProjects()));
      // Crawlers fetch this rarely, so a new project may take up to an hour to appear in it.
      return { status: 200, body: xml, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600', ...API_SECURITY_HEADERS } };
    } catch (err) {
      // A 503 tells a crawler to come back later and keep the copy it has. A sitemap of the static
      // pages alone would read as every project page having gone.
      logError('Sitemap failed', err);
      return { status: 503, body: 'Sitemap temporarily unavailable', headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3600', ...API_SECURITY_HEADERS } };
    }
  },
});
