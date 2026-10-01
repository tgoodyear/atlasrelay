// A real Playwright trace of a key pasted into a password field and posted in a JSON body, as the
// pledge form does, then redacted as run.mjs redacts the results: the key must be gone from every
// file in the archive, the request body included. Needs Playwright's Chromium; skipped without it
// unless E2E_TRACE_TEST_REQUIRED=1 (the browser job in deploy.yml sets it).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { redactTree, secretValues, variants } from '../lib/redact.mjs';

// A fake key: the shape of a RIPE Atlas key, and nothing else.
const KEY = '7c2b9e1a-5d3f-4a6b-9c8d-0e1f2a3b4c5d';

/** @param {string} dir @returns {string[]} */
function files(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

/** @param {string} zip @param {string} into @returns {string[]} the archive's files holding the key */
function filesWithKey(zip, into) {
  execFileSync('unzip', ['-qq', '-o', zip, '-d', into]);
  return files(into).filter((f) => readFileSync(f).toString('latin1').toLowerCase().includes(KEY));
}

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  if (process.env.E2E_TRACE_TEST_REQUIRED === '1') throw err;
}

test('a key pasted into a password field is redacted from the trace, request body included', { skip: !browser && 'Chromium is not installed (npx playwright install chromium)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-redaction-'));
  try {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await page.route('https://site.test/**', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"refused"}' })
        : route.fulfill({
            contentType: 'text/html',
            body: `<label for="k">RIPE Atlas API key</label><input id="k" type="password" autocomplete="off">
              <button onclick="fetch('/api/projects/x/pledges', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ method: 'api', amount: 100, apiKey: document.getElementById('k').value }) })
                .then(() => document.body.append('answered'))">Transfer 100 credits</button>`,
          }),
    );
    await page.goto('https://site.test/projects/x');
    await page.getByLabel('RIPE Atlas API key').fill(KEY);
    await page.getByRole('button', { name: 'Transfer 100 credits' }).click();
    await page.getByText('answered').waitFor();
    const zip = join(dir, 'results', 'trace.zip');
    await context.tracing.stop({ path: zip });
    await context.close();

    // The test is only worth something if the trace held the key to begin with.
    const before = filesWithKey(zip, join(dir, 'before'));
    assert.ok(before.some((f) => f.includes('resources')), 'the request body is not in the trace');
    assert.ok(before.some((f) => f.endsWith('.trace')), 'the fill action is not in the trace');

    const result = redactTree(join(dir, 'results'), variants(secretValues({ E2E_RIPE_DONOR_KEY: KEY })));
    assert.deepEqual(result.redacted, ['trace.zip']);
    assert.deepEqual(filesWithKey(zip, join(dir, 'after')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => browser?.close());
