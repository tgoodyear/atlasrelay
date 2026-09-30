import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_MAX_AGE, PAGE_SECURITY_HEADERS, projectPageResponse, type PageTemplates } from '../src/lib/projectPage';
import type { Project } from '../src/lib/store';
import { invocationLog, type LogSink } from '../src/lib/telemetry';

// process.cwd() is the api workspace when npm runs the tests; see source.test.ts.
const repoRoot = join(process.cwd(), '..');
const index = readFileSync(join(repoRoot, 'web/index.html'), 'utf8');
const templates: PageTemplates = { project: index, notFound: '<!doctype html><title>Page not found | Atlas Relay</title><p>404 page</p>' };

const ID = 'mf1abcd0000xyz12';
const URL_OF = (path: string): string => `https://atlasrelay.org${path}`;

function project(over: Partial<Project> = {}): Project {
  return {
    id: ID,
    ownerId: 'owner-1',
    ownerName: 'Ada',
    title: 'Anycast catchments',
    summary: 'Mapping anycast catchments from every probe.',
    description: 'Long description.',
    creditsRequested: 1000,
    creditsConfirmed: 0,
    creditsPending: 0,
    status: 'open',
    tags: [],
    affiliation: '',
    homepageUrl: '',
    repoUrl: '',
    paperUrl: '',
    deadline: '',
    resultsSummary: '',
    resultsUrl: '',
    resultsPostedAt: '',
    moderationClosed: false,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

/** A store stub that records which ids were read. */
function store(result: Project | null | Error): { load: (id: string) => Promise<Project | null>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    load: async (id) => {
      reads.push(id);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function capture(): { sink: LogSink; lines: { level: string; text: string }[] } {
  const lines: { level: string; text: string }[] = [];
  const push = (level: string) => (...args: unknown[]) => lines.push({ level, text: args.map(String).join(' ') });
  return { sink: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

test('a public project is 200 with its own head, cached briefly, indexable', async () => {
  const s = store(project());
  const res = await projectPageResponse(URL_OF(`/projects/${ID}`), s.load, templates);
  assert.equal(res.status, 200);
  assert.deepEqual(s.reads, [ID]);
  assert.ok(res.body.includes('<title>Anycast catchments | Atlas Relay</title>'));
  assert.ok(res.body.includes(`<link rel="canonical" href="https://atlasrelay.org/projects/${ID}" />`));
  assert.equal(res.headers['cache-control'], `public, max-age=${PAGE_MAX_AGE}`);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['x-robots-tag'], undefined);
  assert.ok(!res.body.includes('name="robots"'));
});

test('a closed project is still a public page', async () => {
  const res = await projectPageResponse(URL_OF(`/projects/${ID}`), store(project({ status: 'closed' })).load, templates);
  assert.equal(res.status, 200);
});

test('a project that does not exist is 404 with the 404 page and noindex', async () => {
  const res = await projectPageResponse(URL_OF(`/projects/${ID}`), store(null).load, templates);
  assert.equal(res.status, 404);
  assert.equal(res.body, templates.notFound);
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.equal(res.headers['cache-control'], `public, max-age=${PAGE_MAX_AGE}`);
});

test('a project an operator took down is 404, like the sitemap and the API', async () => {
  const res = await projectPageResponse(URL_OF(`/projects/${ID}`), store(project({ moderationClosed: true, status: 'closed' })).load, templates);
  assert.equal(res.status, 404);
  assert.equal(res.body, templates.notFound);
  assert.ok(!res.body.includes('Anycast'));
});

test('a malformed id or any other path is 404 without touching storage', async () => {
  for (const path of ['/projects/NOTANID00000000', '/projects/<script>', '/projects/a/b/c', `/projects/${ID}/pledges`, '/api/project-page', '/projects/..%2Fx']) {
    const s = store(project());
    const res = await projectPageResponse(URL_OF(path), s.load, templates);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, templates.notFound, path);
    assert.deepEqual(s.reads, [], path);
  }
});

test('the edit form is 200 with noindex and no storage read', async () => {
  const s = store(project());
  const res = await projectPageResponse(URL_OF(`/projects/${ID}/edit`), s.load, templates);
  assert.equal(res.status, 200);
  assert.deepEqual(s.reads, []);
  assert.ok(res.body.includes('<title>Edit project | Atlas Relay</title>'));
  assert.ok(res.body.includes('<meta name="robots" content="noindex" />'));
  assert.equal(res.headers['x-robots-tag'], 'noindex');
});

test('a storage failure serves the generic shell with noindex and no-store, and logs only the error class', async () => {
  const { sink, lines } = capture();
  const err = Object.assign(new Error('secret detail from the request'), { code: 'ServiceUnavailable', statusCode: 503 });
  const res = await invocationLog.run(sink, () => projectPageResponse(URL_OF(`/projects/${ID}`), store(err).load, templates));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.equal(res.body.replace(/\n[ \t]*<meta name="robots" content="noindex" \/>/, ''), templates.project);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  assert.deepEqual(JSON.parse(lines[0].text), {
    event: 'error',
    message: 'Project page: could not read the project',
    error: 'Error code=ServiceUnavailable status=503',
  });
  assert.ok(!lines[0].text.includes('secret'));
});

test('without x-ms-original-url the generic shell is served and the gap is logged', async () => {
  for (const header of [null, undefined, '']) {
    const { sink, lines } = capture();
    const s = store(project());
    const res = await invocationLog.run(sink, () => projectPageResponse(header, s.load, templates));
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    assert.deepEqual(s.reads, []);
    assert.deepEqual(JSON.parse(lines[0].text), { outcome: 'no-original-url', event: 'project-page' });
    assert.equal(lines[0].level, 'warn');
  }
});

test('a template the renderer cannot use falls back instead of failing the request', async () => {
  const { sink, lines } = capture();
  const broken: PageTemplates = { project: '<!doctype html><title>x</title>', notFound: templates.notFound };
  const res = await invocationLog.run(sink, () => projectPageResponse(URL_OF(`/projects/${ID}`), store(project()).load, broken));
  assert.equal(res.status, 200);
  assert.equal(res.body, broken.project);
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.equal(JSON.parse(lines[0].text).message, 'Project page: could not render the template');
});

test('every page carries the security headers staticwebapp.config.json gives static pages', async () => {
  // SWA does not add globalHeaders to function responses, so the function sets them itself.
  const config = JSON.parse(readFileSync(join(repoRoot, 'web/public/staticwebapp.config.json'), 'utf8')) as { globalHeaders: Record<string, string> };
  const { 'strict-transport-security': _hsts, ...expected } = config.globalHeaders;
  assert.deepEqual(PAGE_SECURITY_HEADERS, expected);
  for (const result of [project(), null, new Error('x')]) {
    const res = await invocationLog.run(capture().sink, () => projectPageResponse(URL_OF(`/projects/${ID}`), store(result).load, templates));
    for (const [k, v] of Object.entries(expected)) assert.equal(res.headers[k], v, `${k} on a ${res.status}`);
  }
});
