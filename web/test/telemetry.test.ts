import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { amountBucket, CAMPAIGN_MAX, campaignFrom, linkAction, referrerOrigin, routeName, scrubItem, scrubText, stripQuery } from '../src/lib/telemetry-scrub';

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

test('campaign tags: utm_source, utm_medium and utm_campaign only', () => {
  assert.deepEqual(campaignFrom(new URL('https://atlasrelay.org/?utm_source=ripe-atlas-list').search), { utm_source: 'ripe-atlas-list' });
  assert.deepEqual(
    campaignFrom('?utm_source=Newsletter&utm_medium=Email&utm_campaign=Sept+2026&utm_term=dns&utm_content=a&gclid=x&fbclid=y&q=secret'),
    { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'sept 2026' },
  );
  assert.deepEqual(campaignFrom(''), {});
  assert.deepEqual(campaignFrom('?utm_source=&utm_medium=%20%20'), {});
  // Only the first value of a repeated key, and key names are matched exactly.
  assert.deepEqual(campaignFrom('?utm_source=a&utm_source=b&UTM_MEDIUM=c'), { utm_source: 'a' });
});

test('campaign values are lowercased, redacted and capped', () => {
  assert.deepEqual(campaignFrom(`?utm_source=${KEY.toUpperCase()}&utm_medium=Someone%40Example.org&utm_campaign=a%0Ab`), {
    utm_source: '[uuid]',
    utm_medium: '[email]',
    utm_campaign: 'ab',
  });
  // Encoded twice, and a URL with its own query inside the value.
  assert.deepEqual(campaignFrom('?utm_source=someone%2540example.org&utm_campaign=https%3A%2F%2Fx.example%2F%3Ftoken%3Dabc'), {
    utm_source: '[email]',
    utm_campaign: 'https://x.example/',
  });
  const long = campaignFrom(`?utm_campaign=${'x'.repeat(200)}`);
  assert.equal(long.utm_campaign.length, CAMPAIGN_MAX);
  // Redaction happens before the cut, so a cut never leaves part of a key behind.
  const cut = campaignFrom(`?utm_campaign=${'x'.repeat(60)}${KEY}`);
  assert.equal(cut.utm_campaign.length, CAMPAIGN_MAX);
  assert.equal(cut.utm_campaign.includes('aaaa'), false);
  // A control character inside a key or an address does not hide it from redaction.
  const split = campaignFrom(`?utm_campaign=${'x'.repeat(40)}${KEY.slice(0, 10)}%0A${KEY.slice(10)}&utm_source=someone%0A@example.org`);
  assert.deepEqual(split, { utm_campaign: `${'x'.repeat(40)}[uuid]`, utm_source: '[email]' });
});

test('the referrer is an origin, "internal" or "direct"', () => {
  assert.equal(referrerOrigin('', 'atlasrelay.org'), 'direct');
  assert.equal(referrerOrigin('https://news.example/item?id=1#c', 'atlasrelay.org'), 'https://news.example');
  assert.equal(referrerOrigin('https://www.atlasrelay.org/projects', 'atlasrelay.org'), 'internal');
  assert.equal(referrerOrigin('https://atlasrelay.org/', 'www.atlasrelay.org'), 'internal');
  assert.equal(referrerOrigin('https://WWW.AtlasRelay.org/', 'atlasrelay.org'), 'internal');
  assert.equal(referrerOrigin('https://atlasrelay.org.example/', 'atlasrelay.org'), 'https://atlasrelay.org.example');
  assert.equal(referrerOrigin('android-app://com.google.android.gm/', 'atlasrelay.org'), 'android-app://com.google.android.gm');
  assert.equal(referrerOrigin('not a url', 'atlasrelay.org'), 'unknown');
});

test('pledge amounts are sent to the nearest power of ten', () => {
  assert.equal(amountBucket(1), '1-999');
  assert.equal(amountBucket(999), '1-999');
  assert.equal(amountBucket(1000), '1000-9999');
  assert.equal(amountBucket(25_000), '10000-99999');
  assert.equal(amountBucket(999_999), '100000-999999');
  assert.equal(amountBucket(5_000_000), '1000000+');
  assert.equal(amountBucket(0), 'unknown');
  assert.equal(amountBucket(Number.NaN), 'unknown');
});

test('sign-in links and atlas.ripe.net links are counted, other links are not', () => {
  const page = 'https://atlasrelay.org/projects/mf3k2x9a0abc1234';
  assert.deepEqual(linkAction('/.auth/login/github?post_login_redirect_uri=%2Fdashboard', page), { name: 'sign-in-clicked', properties: { provider: 'github' } });
  assert.deepEqual(linkAction('https://atlasrelay.org/.auth/login/aad', page), { name: 'sign-in-clicked', properties: { provider: 'aad' } });
  assert.deepEqual(linkAction('/.auth/login/orcid?post_login_redirect_uri=%2Fprojects%2Fabc', page), { name: 'sign-in-clicked', properties: { provider: 'orcid' } });
  assert.deepEqual(linkAction('/.auth/login/google', page), { name: 'sign-in-clicked', properties: { provider: 'google' } });
  // The sign-in page is a page, not a sign-in.
  assert.equal(linkAction('/signin?next=%2Fprojects%2Fabc', page), null);
  assert.deepEqual(linkAction('https://atlas.ripe.net/credits/transfer/?to=someone@example.org', page), {
    name: 'outbound-click',
    properties: { host: 'atlas.ripe.net', path: '/credits/transfer' },
  });
  assert.deepEqual(linkAction('https://atlas.ripe.net/measurements/12345678/results/latest/', page), {
    name: 'outbound-click',
    properties: { host: 'atlas.ripe.net', path: '/measurements/:n/results' },
  });
  assert.deepEqual(linkAction(`https://atlas.ripe.net/keys/${KEY}/`, page), { name: 'outbound-click', properties: { host: 'atlas.ripe.net', path: '/keys/[uuid]' } });
  assert.equal(linkAction('/.auth/logout', page), null);
  assert.equal(linkAction('/projects', page), null);
  assert.equal(linkAction('https://github.com/tgoodyear/atlasrelay/issues/new', page), null);
  assert.equal(linkAction('https://evil.example/.auth/login/github', page), null);
});

test('page view and action properties survive the scrubber, and keys inside them do not', () => {
  const view = {
    baseData: { name: '/', uri: 'https://atlasrelay.org/', properties: { referrerOrigin: 'direct', utm_source: 'ripe-atlas-list' } },
    data: { referrerOrigin: 'internal' },
  };
  scrubItem(view, 'web', 'load1');
  assert.deepEqual(view.baseData.properties, { referrerOrigin: 'direct', utm_source: 'ripe-atlas-list' });
  assert.deepEqual(view.data, { referrerOrigin: 'internal' });
  const action = { baseData: { name: 'pledge-completed', properties: { method: 'api', amount: '1000-9999', projectId: 'mf3k2x9a0abc1234', note: KEY } } };
  scrubItem(action, 'web', 'load1');
  assert.deepEqual(action.baseData.properties, { method: 'api', amount: '1000-9999', projectId: 'mf3k2x9a0abc1234', note: '[uuid]' });
});

test('the workbook\'s action table runs ops/queries/actions.kql as it is', () => {
  const root = join(import.meta.dirname, '..', '..');
  const saved = readFileSync(join(root, 'ops', 'queries', 'actions.kql'), 'utf8').trimEnd();
  const workbook = JSON.parse(readFileSync(join(root, 'infra', 'workbooks', 'atlasrelay.json'), 'utf8'));
  const items: { name?: string; content?: { query?: string; items?: unknown[] } }[] = [];
  const walk = (list: unknown[]) => {
    for (const item of list as typeof items) {
      items.push(item);
      if (item.content?.items) walk(item.content.items);
    }
  };
  walk(workbook.items);
  assert.equal(items.find((i) => i.name === 'traffic-actions')?.content?.query, saved);
});

test('every action the app sends is one the reports count', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const sent = new Set<string>();
  for (const file of ['pages/ProjectDetail.tsx', 'pages/ProjectForm.tsx', 'components/PledgeDialog.tsx']) {
    for (const m of readFileSync(join(src, file), 'utf8').matchAll(/trackAction\('([a-z-]+)'/g)) sent.add(m[1]);
  }
  for (const name of ['sign-in-clicked', 'outbound-click']) sent.add(name);
  const actions = readFileSync(join(import.meta.dirname, '..', '..', 'ops', 'queries', 'actions.kql'), 'utf8');
  assert.deepEqual([...sent].sort(), ['outbound-click', 'pledge-completed', 'pledge-started', 'project-posted', 'sign-in-clicked']);
  for (const name of sent) assert.ok(actions.includes(`"${name}"`), `${name} is not in actions.kql`);
});
