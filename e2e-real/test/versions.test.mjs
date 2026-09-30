import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The test image runs the browsers of its base image with the @playwright/test it installs, and
// the repository's browser tests use web/package.json's. All three must be the same version.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the Dockerfile, e2e-real and web use one Playwright version', () => {
  const web = JSON.parse(read('../../web/package.json')).devDependencies['@playwright/test'];
  const ours = JSON.parse(read('../package.json')).dependencies['@playwright/test'];
  const from = read('../Dockerfile').match(/^FROM mcr\.microsoft\.com\/playwright:v([0-9.]+)-noble@sha256:[0-9a-f]{64}$/m);
  assert.match(web, /^\d+\.\d+\.\d+$/, 'web/package.json pins @playwright/test exactly');
  assert.equal(ours, web, 'e2e-real/package.json');
  assert.ok(from, 'the Dockerfile pins the Playwright image by tag and digest');
  assert.equal(from[1], web, 'the Dockerfile base image');
});

test('the job default image in Bicep is the same Playwright image', () => {
  const from = read('../Dockerfile').match(/^FROM (\S+)$/m)[1];
  assert.ok(read('../../infra/testharness.bicep').includes(`'${from}'`));
});
