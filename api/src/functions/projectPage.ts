import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { projectPageResponse } from '../lib/projectPage';
import { getProject } from '../lib/store';

// Filled in by api/bundle.mjs with the project shell and the 404 page from the web build, so the
// HTML this returns names the same script and style files as the rest of the deploy.
declare const __PROJECT_SHELL__: string;
declare const __NOT_FOUND_PAGE__: string;

// Served at /projects/{id}: staticwebapp.config.json rewrites /projects/* here, after the rules
// for /projects and /projects/new. A rewrite cannot pass the id on, so it is read from
// x-ms-original-url, which SWA sets to the URL the browser asked for. See lib/projectPage.ts.
app.http('project-page', {
  route: 'project-page',
  // HEAD as well, because some link preview fetchers check a URL with HEAD before reading it.
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    const res = await projectPageResponse(req.headers.get('x-ms-original-url'), getProject, {
      project: __PROJECT_SHELL__,
      notFound: __NOT_FOUND_PAGE__,
    });
    return { status: res.status, body: req.method === 'HEAD' ? undefined : res.body, headers: res.headers };
  },
});
