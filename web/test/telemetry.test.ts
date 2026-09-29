import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeName, scrubItem, scrubText, stripQuery } from '../src/lib/telemetry-scrub';

// What the browser sends to Application Insights. A RIPE Atlas API key is a UUID and can sit in
// the transfer form, so nothing shaped like one may leave the page, and neither may query strings,
// email addresses or user ids.

const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('query strings and fragments are removed from URLs and paths', () => {
  assert.equal(stripQuery('https://atlasrelay.org/projects?q=dns&tag=ping#top'), 'https://atlasrelay.org/projects');
  assert.equal(stripQuery('/api/projects?status=open'), '/api/projects');
  assert.equal(stripQuery('/projects/abc'), '/projects/abc');
});

test('free text loses keys, email addresses and query strings', () => {
  const text = `Failed to fetch https://atlasrelay.org/api/x?token=abc for ${KEY} (someone@example.org)`;
  assert.equal(scrubText(text), 'Failed to fetch https://atlasrelay.org/api/x for [uuid] ([email])');
  assert.equal(scrubText('Failed to fetch /api/projects?q=secret&tag=dns'), 'Failed to fetch /api/projects');
  assert.equal(scrubText('GET "/projects#top" failed'), 'GET "/projects" failed');
  // A slash inside a word or path is not the start of a URL.
  assert.equal(scrubText('ratio 3/4?'), 'ratio 3/4?');
  // Pathnames arrive percent-encoded, sometimes twice.
  assert.equal(scrubText('/projects/someone%40example.org'), '/projects/[email]');
  assert.equal(scrubText('/p/00000000%2D0000%2D4000%2D8000%2D00000000dead'), '/p/[uuid]');
  assert.equal(scrubText('/x/a%2540b.example'), '/x/[email]');
  assert.equal(scrubText('/caf%C3%A9'), '/caf%C3%A9');
});

test('a page view keeps its path and loses its query, referrer path and user ids', () => {
  const item = {
    baseData: { name: '/projects', uri: 'https://atlasrelay.org/projects?q=someone@example.org', refUri: 'https://search.example/?q=atlas+relay' },
    tags: { 'ai.user.id': 'abc', 'ai.user.authUserId': 'github|123', 'ai.operation.name': '/projects?q=x' },
  };
  scrubItem(item, 'web', 'load1');
  assert.equal(item.baseData.uri, 'https://atlasrelay.org/projects');
  assert.equal(item.baseData.refUri, 'https://search.example');
  assert.deepEqual(item.tags, { 'ai.operation.name': '/projects', 'ai.cloud.role': 'web', 'ai.session.id': 'load1' });
});

test('every tag is scrubbed, not only the ones named', () => {
  const item = { tags: { 'ai.operation.name': `/someone@example.org/${KEY}`, 'ai.location.ip': 'x', 'ai.custom': `key ${KEY}` } };
  scrubItem(item, 'web', 'load1');
  const sent = JSON.stringify(item);
  assert.equal(sent.includes(KEY), false);
  assert.equal(sent.includes('someone@example.org'), false);
});

test('an exception that quotes a key or a body does not carry it out', () => {
  const item = {
    baseData: {
      exceptions: [{
        typeName: 'Error',
        message: `Request failed: {"apiKey":"${KEY}","recipient":"owner@example.org"}`,
        stack: `Error: Request failed ${KEY}\n    at https://atlasrelay.org/assets/index-abc.js?v=1:1:200`,
        parsedStack: [{ method: 'send', fileName: 'https://atlasrelay.org/assets/index-abc.js?v=1', level: 0, line: 1 }],
      }],
    },
    data: { note: KEY },
  };
  scrubItem(item, 'web', 'load1');
  const sent = JSON.stringify(item);
  assert.equal(sent.includes(KEY), false);
  assert.equal(sent.includes('owner@example.org'), false);
  assert.equal(sent.includes('?v=1'), false);
});

test('a dependency keeps method, path and status but not the query', () => {
  const item = {
    baseData: { name: 'GET /api/projects?q=secret', target: 'atlasrelay.org', data: 'https://atlasrelay.org/api/projects?q=secret', resultCode: '200', type: 'Fetch' },
  };
  scrubItem(item, 'web', 'load1');
  assert.equal(item.baseData.name, 'GET /api/projects');
  assert.equal(item.baseData.data, 'https://atlasrelay.org/api/projects');
  assert.equal(item.baseData.resultCode, '200');
});

test('page view names follow the routes in App.tsx', () => {
  const app = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
  const paths = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
  assert.ok(paths.length >= 5, 'expected to find the routes in App.tsx');
  for (const p of paths) {
    const concrete = `/${p.replace(/:id/g, 'mf3k2x9a0abc1234')}`;
    assert.equal(routeName(concrete), `/${p}`, `route ${p}`);
  }
  assert.equal(routeName('/'), '/');
  assert.equal(routeName('/projects/'), '/projects');
  assert.equal(routeName('/wp-admin'), '(not found)');
  assert.equal(routeName('/Projects/'), '/projects');
  assert.equal(routeName('/HOW-IT-WORKS'), '/how-it-works');
});
