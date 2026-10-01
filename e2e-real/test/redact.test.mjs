import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MASK, lineRedactor, redactBuffer, redactText, redactTree, secretValues, variants } from '../lib/redact.mjs';

const SECRET = 'p@ss "word"/+=&';

test('variants cover the JSON-escaped and URL-encoded forms, longest first', () => {
  const v = variants([SECRET, '', undefined]);
  assert.ok(v.includes(SECRET));
  assert.ok(v.includes('p@ss \\"word\\"/+=&'));
  assert.ok(v.includes(encodeURIComponent(SECRET)));
  assert.deepEqual(v, [...v].sort((a, b) => b.length - a.length));
});

test('redactText and redactBuffer replace every occurrence', () => {
  const v = variants([SECRET]);
  assert.equal(redactText(`a ${SECRET} b ${SECRET}`, v), `a ${MASK} b ${MASK}`);
  const r = redactBuffer(Buffer.from(`{"value":"${JSON.stringify(SECRET).slice(1, -1)}"}`), v);
  assert.equal(r.changed, true);
  assert.equal(r.buf.toString(), `{"value":"${MASK}"}`);
  assert.equal(redactBuffer(Buffer.from('clean'), v).changed, false);
});

test('lineRedactor catches a secret split across chunks', () => {
  const out = [];
  const r = lineRedactor((s) => out.push(s), () => variants([SECRET]));
  r.push(`before ${SECRET.slice(0, 4)}`);
  r.push(`${SECRET.slice(4)} after\nnext`);
  r.end();
  assert.equal(out.join(''), `before ${MASK} after\nnext`);
});

test('redactTree rewrites files and the entries of zip archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-test-'));
  try {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'report.json'), `{"cookie":"StaticWebAppsAuthCookie=${SECRET}"}`);
    writeFileSync(join(dir, 'clean.txt'), 'nothing here');
    const entries = join(dir, 'entries');
    mkdirSync(join(entries, 'resources'), { recursive: true });
    writeFileSync(join(entries, 'trace.network'), `{"headers":[{"name":"cookie","value":"x=${encodeURIComponent(SECRET)}"}]}`);
    writeFileSync(join(entries, 'resources', 'body'), `token ${SECRET}`);
    execFileSync('zip', ['-q', '-r', join(dir, 'a', 'trace.zip'), '.'], { cwd: entries });
    rmSync(entries, { recursive: true });

    const result = redactTree(dir, variants([SECRET]));
    assert.deepEqual(result.redacted.sort(), [join('a', 'report.json'), join('a', 'trace.zip')].sort());
    assert.deepEqual(result.withheld, []);
    assert.equal(readFileSync(join(dir, 'a', 'report.json'), 'utf8'), `{"cookie":"StaticWebAppsAuthCookie=${MASK}"}`);
    const network = execFileSync('unzip', ['-p', join(dir, 'a', 'trace.zip'), 'trace.network'], { encoding: 'utf8' });
    assert.equal(network, `{"headers":[{"name":"cookie","value":"x=${MASK}"}]}`);
    const body = execFileSync('unzip', ['-p', join(dir, 'a', 'trace.zip'), 'resources/body'], { encoding: 'utf8' });
    assert.equal(body, `token ${MASK}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactTree deletes a zip it cannot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-test-'));
  try {
    writeFileSync(join(dir, 'broken.zip'), `not a zip ${SECRET}`);
    const result = redactTree(dir, variants([SECRET]));
    assert.deepEqual(result.withheld, ['broken.zip']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fake RIPE Atlas keys and accounts: the same shapes as real ones, and nothing else.
const DONOR_KEY = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
const RECIPIENT_KEY = 'AABBCCDD-1122-4334-8556-77889900AABB';
const ACCOUNT = 'Recipient.Account@example.org';
const ripeEnv = {
  E2E_RESEARCHER_USERNAME: 'researcher@tenant.example',
  E2E_RESEARCHER_PASSWORD: SECRET,
  E2E_RIPE_DONOR_KEY: DONOR_KEY,
  E2E_RIPE_DONOR_ACCOUNT: 'donor@example.org',
  E2E_RIPE_RECIPIENT_KEY: RECIPIENT_KEY,
  E2E_RIPE_RECIPIENT_ACCOUNT: ACCOUNT,
};

test('secretValues covers the passwords, the RIPE keys and accounts in both cases, and not the usernames', () => {
  const values = secretValues(ripeEnv);
  assert.ok(!values.includes('researcher@tenant.example'));
  for (const v of [SECRET, DONOR_KEY, DONOR_KEY.toUpperCase(), RECIPIENT_KEY, RECIPIENT_KEY.toLowerCase(), ACCOUNT, ACCOUNT.toLowerCase(), 'donor@example.org']) {
    assert.ok(values.includes(v), v);
  }
});

test('a pasted RIPE key is redacted from every place a trace records it', () => {
  const needles = variants(secretValues(ripeEnv));
  const dir = mkdtempSync(join(tmpdir(), 'redact-test-'));
  try {
    // The places a real Playwright 1.63 trace holds a value typed into a password field and sent
    // in a JSON request body (test/trace-redaction.test.mjs makes one): the runner's step log, the
    // browser action log, and the request body stored as a resource.
    const entries = join(dir, 'entries');
    mkdirSync(join(entries, 'resources'), { recursive: true });
    writeFileSync(join(entries, 'test.trace'), `{"type":"before","title":"Fill \\"${DONOR_KEY}\\" getByLabel('RIPE Atlas API key')","params":{"value":"${DONOR_KEY}"}}`);
    writeFileSync(join(entries, '0-trace.trace'), `{"method":"fill","params":{"selector":"internal:label=\\"RIPE Atlas API key\\"i","value":"${DONOR_KEY}"}}`);
    writeFileSync(join(entries, 'resources', 'a1b2.json'), JSON.stringify({ method: 'api', amount: 100, apiKey: DONOR_KEY.toUpperCase() }));
    writeFileSync(join(entries, '0-trace.network'), `{"request":{"url":"https://atlas.example/credits/","headers":[{"name":"authorization","value":"Key ${RECIPIENT_KEY.toLowerCase()}"}]}}`);
    writeFileSync(join(entries, 'resources', 'c3d4.html'), `<input id="atlasEmail" value="${ACCOUNT.toLowerCase()}">`);
    mkdirSync(join(dir, 'results'));
    execFileSync('zip', ['-q', '-r', join(dir, 'results', 'trace.zip'), '.'], { cwd: entries });
    rmSync(entries, { recursive: true });
    writeFileSync(join(dir, 'results', 'report.json'), JSON.stringify({ error: `expected ${ACCOUNT} with key ${RECIPIENT_KEY}` }));

    const result = redactTree(join(dir, 'results'), needles);
    assert.deepEqual(result.redacted.sort(), ['report.json', 'trace.zip']);
    const out = join(dir, 'out');
    execFileSync('unzip', ['-qq', join(dir, 'results', 'trace.zip'), '-d', out]);
    const everything = [
      readFileSync(join(dir, 'results', 'report.json'), 'utf8'),
      ...['test.trace', '0-trace.trace', '0-trace.network', 'resources/a1b2.json', 'resources/c3d4.html'].map((f) => readFileSync(join(out, f), 'utf8')),
    ].join('\n');
    for (const secret of [DONOR_KEY, RECIPIENT_KEY, ACCOUNT]) {
      assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), `${secret} left in the results`);
    }
    assert.ok(everything.includes(`"apiKey":"${MASK}"`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the console output of a run has the keys masked as each line is written', () => {
  const out = [];
  const r = lineRedactor((s) => out.push(s), () => variants(secretValues(ripeEnv)));
  r.push(`[ripe] key ${DONOR_KEY.slice(0, 10)}`);
  r.push(`${DONOR_KEY.slice(10)} sent to ${ACCOUNT.toUpperCase()}\n`);
  r.end();
  assert.equal(out.join(''), `[ripe] key ${MASK} sent to ${MASK}\n`);
});
