import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MASK, lineRedactor, redactBuffer, redactText, redactTree, variants } from '../lib/redact.mjs';

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
