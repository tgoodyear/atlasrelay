// Which address the full-flow tests sign in on (scripts/lib/e2e-job.sh: e2e_site_address), run in
// bash against a fake curl that answers from a script of responses. Nothing reaches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_JOB_SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'e2e-job.sh');
const SCRIPT = '/assets/index-abc123.js';

// Each call to the custom domain takes the next line of $FAKE/answers: "build" serves this build,
// anything else the platform's 404. Past the last line, the last answer repeats.
const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
echo "\${url%%\\?*}" >> "$FAKE/calls"
n=$(grep -c . "$FAKE/calls")
answer=$(sed -n "\${n}p" "$FAKE/answers"); [ -n "$answer" ] || answer=$(tail -1 "$FAKE/answers")
if [ "$answer" = build ]; then echo '<script src="${SCRIPT}"></script>'; exit 0; fi
echo "curl: (22) The requested URL returned error: 404" >&2; exit 22
`;

function run(custom, answers) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-site-address-'));
  const bin = join(dir, 'bin');
  const fake = join(dir, 'fake');
  mkdirSync(bin);
  mkdirSync(fake);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(join(fake, 'answers'), answers.join('\n') + '\n');
  writeFileSync(join(fake, 'calls'), '');
  // No waiting in a test.
  const script = `set -euo pipefail; . "${E2E_JOB_SH}"; _e2e_sleep() { :; }; E2E_ENV=dev; e2e_site_address default.azurestaticapps.net "${custom}" "${SCRIPT}"`;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake }, encoding: 'utf8' });
  const calls = readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr, calls };
}

test('without a custom domain, the default hostname, asking nothing', () => {
  const r = run('', ['build']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'https://default.azurestaticapps.net');
  assert.deepEqual(r.calls, []);
});

test('a custom domain that serves the build ten times in a row is used', () => {
  const r = run('dev.example.org', ['build']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'https://dev.example.org');
  assert.equal(r.calls.length, 10);
  assert.ok(r.calls.every((c) => c === 'https://dev.example.org/'));
});

test('a 404 between answers starts the count again', () => {
  const r = run('dev.example.org', [...Array(9).fill('build'), '404', 'build']);
  assert.equal(r.stdout, 'https://dev.example.org');
  assert.equal(r.calls.length, 20);
});

test('a custom domain that never settles falls back to the default hostname, with a warning', () => {
  const r = run('dev.example.org', ['404']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'https://default.azurestaticapps.net');
  assert.equal(r.calls.length, 60);
  assert.match(r.stderr, /warning: https:\/\/dev\.example\.org does not serve this build reliably/);
  assert.match(r.stderr, /register-signin\.sh dev aad/);
});
