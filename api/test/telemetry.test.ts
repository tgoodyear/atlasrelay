import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getCredits, transferCredits } from '../src/lib/atlas';
import { invocationLog, LogSink, logDependency, logError, logEvent, scrub, tableDependencyPolicy, tableOperation } from '../src/lib/telemetry';

// SECURITY.md promises a pasted RIPE Atlas key cannot reach a log. Every log line the API writes
// goes to Application Insights, so these tests capture what would be written and look for the key.

const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function capture(): { sink: LogSink; lines: { level: string; text: string }[] } {
  const lines: { level: string; text: string }[] = [];
  const push = (level: string) => (...args: unknown[]) => lines.push({ level, text: args.map(String).join(' ') });
  return { sink: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('scrub removes anything shaped like a key or an email address', () => {
  assert.equal(scrub(`Key ${KEY} for someone@example.org`), 'Key [uuid] for [email]');
  assert.equal(scrub(KEY.toUpperCase()), '[uuid]');
  // This API's own ids are base36 and are not touched, so project and pledge ids stay readable.
  assert.equal(scrub('project mf3k2x9a0abc1234 pledge mf3k2x9a0zzz9876'), 'project mf3k2x9a0abc1234 pledge mf3k2x9a0zzz9876');
});

test('logError never writes the message of the error it is given', async () => {
  const { sink, lines } = capture();
  const leaky = Object.assign(new Error(`request failed: {"apiKey":"${KEY}"}`), { code: 'EntityAlreadyExists', statusCode: 409 });
  invocationLog.run(sink, () => logError('Could not create a pledge row', leaky));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  const line = JSON.parse(lines[0].text);
  assert.deepEqual(line, { event: 'error', message: 'Could not create a pledge row', error: 'Error code=EntityAlreadyExists status=409' });
  assert.equal(lines[0].text.includes(KEY), false);
  assert.equal(lines[0].text.includes('apiKey'), false);
});

test('a key passed in a field by mistake is still scrubbed', () => {
  const { sink, lines } = capture();
  invocationLog.run(sink, () => logEvent('transfer', { outcome: 'refused', note: `key ${KEY}`, recipient: 'owner@example.org' }));
  assert.equal(lines[0].text.includes(KEY), false);
  assert.equal(lines[0].text.includes('owner@example.org'), false);
  assert.equal(JSON.parse(lines[0].text).event, 'transfer');
});

test('without an invocation the line goes to the console', () => {
  const real = console.info;
  const seen: string[] = [];
  console.info = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    logDependency({ type: 'RIPE Atlas', target: 'atlas.ripe.net', name: 'GET /credits/', resultCode: '200', success: true, durationMs: 12.6 });
  } finally {
    console.info = real;
  }
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]), {
    event: 'dependency', type: 'RIPE Atlas', target: 'atlas.ripe.net', name: 'GET /credits/', resultCode: '200', success: true, durationMs: 13,
  });
});

test('RIPE Atlas calls are logged as dependencies without the key', async () => {
  const { sink, lines } = capture();
  await invocationLog.run(sink, () =>
    withFetch(async () => new Response(JSON.stringify({ current_balance: 5 }), { status: 200 }), () => getCredits(KEY)),
  );
  await invocationLog.run(sink, () =>
    withFetch(async () => new Response('{}', { status: 503 }), () => transferCredits(KEY, 'owner@example.org', 10).catch(() => null)),
  );
  // A network failure whose message quotes the key, the worst case for a careless logger.
  await invocationLog.run(sink, () =>
    withFetch(async () => { throw new TypeError(`fetch failed for Key ${KEY}`); }, () => transferCredits(KEY, 'owner@example.org', 10).catch(() => null)),
  );
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(l.text.includes(KEY), false, l.text);
    assert.equal(l.text.includes('owner@example.org'), false, l.text);
    assert.equal(/authorization/i.test(l.text), false, l.text);
  }
  const [balance, fivexx, network] = lines.map((l) => JSON.parse(l.text));
  assert.equal(balance.name, 'GET /credits/');
  assert.equal(balance.resultCode, '200');
  assert.equal(balance.success, true);
  assert.equal(fivexx.name, 'POST /credits/transfers/');
  assert.equal(fivexx.resultCode, '503');
  assert.equal(fivexx.success, false);
  assert.equal(lines[1].level, 'warn');
  assert.equal(network.resultCode, 'network');
  assert.equal(network.success, false);
});

test('Table Storage requests are named without keys or filters', () => {
  const base = 'https://st.table.core.windows.net';
  assert.equal(tableOperation('GET', `${base}/projects(PartitionKey='owner-abc123',RowKey='mf3k2x9a0abc1234')`), 'GET projects entity');
  assert.equal(tableOperation('GET', `${base}/projects()?$filter=PartitionKey%20eq%20'owner-abc123'`), 'GET projects query');
  assert.equal(tableOperation('GET', `${base}/projects?$filter=x`), 'GET projects query');
  assert.equal(tableOperation('POST', `${base}/Tables`), 'POST Tables');
  assert.equal(tableOperation('POST', `${base}/$batch`), 'POST batch');
  assert.equal(tableOperation('PUT', `http://127.0.0.1:10002/devstoreaccount1/claims(PartitionKey='p',RowKey='d')`), 'PUT claims entity');
});

test('the Table Storage policy logs status and never the URL', async () => {
  const { sink, lines } = capture();
  const policy = tableDependencyPolicy();
  const url = "https://st.table.core.windows.net/users(PartitionKey='user',RowKey='github-someone')";
  await invocationLog.run(sink, () => policy.sendRequest({ url, method: 'GET' }, async () => ({ status: 404 })));
  await invocationLog.run(sink, () =>
    policy.sendRequest({ url, method: 'GET' }, async () => { throw Object.assign(new Error('socket hang up'), { code: 'REQUEST_SEND_ERROR' }); }).catch(() => null),
  );
  const [notFound, dropped] = lines.map((l) => JSON.parse(l.text));
  assert.deepEqual({ ...notFound, durationMs: 0 }, {
    event: 'dependency', type: 'Table Storage', target: 'st.table.core.windows.net', name: 'GET users entity', resultCode: '404', success: true, durationMs: 0,
  });
  assert.equal(dropped.resultCode, 'network');
  assert.equal(dropped.success, false);
  for (const l of lines) assert.equal(l.text.includes('github-someone'), false);
});

test('the API writes logs only through lib/telemetry.ts', () => {
  // Anything written with console.* skips the scrub and the invocation logger, so it would reach
  // Application Insights, if at all, unscrubbed and without the request's operation id.
  const root = join(process.cwd(), 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith(join('lib', 'telemetry.ts'))) {
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*\/\//.test(line)) return;
          if (/\bconsole\.(log|info|warn|error|debug|trace)\(/.test(line)) offenders.push(`${relative(root, full)}:${i + 1}`);
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
