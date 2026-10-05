// The sign-in steps of rebuilding a torn-down environment (scripts/lib/env.sh: signin_vault_access,
// sync_aad_trust), run in bash against a fake az that records its calls. Nothing reaches Azure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_SH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'env.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;

// Answers the calls these functions make, from files in $FAKE: "readable" (the operator may read
// the vault), "forbidden" (else the vault refuses with 403; without either it doesn't exist), "me"
// (the signed-in user's id) and "fic" (the static-web-apps-<env> credential, as Graph's filtered
// answer). A deployment of the operator's role makes the vault readable.
const FAKE_AZ = `#!/usr/bin/env bash
# One line per call: the JSON bodies span several.
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >> "$FAKE/calls"
case "$*" in
  "keyvault secret list"*)
    if [ -f "$FAKE/readable" ]; then echo signin-github-client-id; exit 0; fi
    if [ -f "$FAKE/forbidden" ]; then echo "(Forbidden) Caller is not authorized to perform action on resource. Code: Forbidden" >&2; exit 1; fi
    echo "(VaultNotFound) The vault was not found" >&2; exit 1 ;;
  "deployment group create"*) touch "$FAKE/readable" ;;
  "ad signed-in-user show"*) cat "$FAKE/me" 2> /dev/null || true ;;
  "rest --method get --url https://graph.microsoft.com/v1.0/applications(appId="*) echo app-object ;;
  "rest --method get --url https://graph.microsoft.com/v1.0/applications/app-object/federatedIdentityCredentials"*)
    cat "$FAKE/fic" 2> /dev/null || true ;;
  "rest --method post"*|"rest --method patch"*) ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 1 ;;
esac
`;

function setup(settings, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'signin-rebuild-'));
  const bin = join(dir, 'bin');
  const fake = join(dir, 'fake');
  mkdirSync(bin);
  mkdirSync(fake);
  mkdirSync(join(dir, '.azure', 'dev'), { recursive: true });
  writeFileSync(join(bin, 'az'), FAKE_AZ);
  chmodSync(join(bin, 'az'), 0o755);
  // No waiting in a test.
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  writeFileSync(
    join(dir, '.azure', 'dev', '.env'),
    Object.entries({ AZURE_SUBSCRIPTION_ID: 'sub', AZURE_TENANT_ID: 'tenant', ...settings })
      .map(([k, v]) => `${k}="${v}"\n`)
      .join(''),
  );
  for (const [name, value] of Object.entries(files)) writeFileSync(join(fake, name), value);
  const run = (fn) => {
    const script = `set -euo pipefail; ENV_NAME=dev; die() { echo "error: $*" >&2; exit 1; }; . "${ENV_SH}"; az_sub; ${fn}`;
    const r = spawnSync('bash', ['-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake },
      encoding: 'utf8',
    });
    const calls = existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout, err: r.stderr, calls };
  };
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const OPERATOR = { SIGNIN_KEY_VAULT_NAME: 'kvs-atlasrelay-dev-abcd', ATLASRELAY_OPERATOR_PRINCIPAL_ID: 'op-1' };

test('a vault that refuses the operator gets the role back under the stack\'s name, then is read', { skip: !hasJq }, () => {
  const t = setup(OPERATOR, { forbidden: '', me: 'op-1' });
  try {
    const r = t.run('signin_vault_access');
    assert.equal(r.status, 0, r.err);
    const deploy = r.calls.filter((c) => c.startsWith('deployment group create'));
    assert.equal(deploy.length, 1);
    // The stack's own module, so the assignment's name is the one the stack gives it.
    assert.match(deploy[0], /--resource-group rg-atlasrelay-dev /);
    assert.match(deploy[0], /--template-file infra\/signin-operator\.bicep /);
    assert.match(deploy[0], /--parameters vaultName=kvs-atlasrelay-dev-abcd operatorPrincipalId=op-1 /);
    assert.match(r.out, /kvs-atlasrelay-dev-abcd can be read/);
  } finally {
    t.cleanup();
  }
});

test('a vault the operator can read, or one that is not there, is left alone', { skip: !hasJq }, () => {
  for (const files of [{ readable: '' }, {}]) {
    const t = setup(OPERATOR, files);
    try {
      const r = t.run('signin_vault_access');
      assert.equal(r.status, 0, r.err);
      assert.deepEqual(r.calls.filter((c) => !c.startsWith('keyvault secret list')), []);
    } finally {
      t.cleanup();
    }
  }
  const t = setup({ ATLASRELAY_OPERATOR_PRINCIPAL_ID: 'op-1' }, { forbidden: '' });
  try {
    const r = t.run('signin_vault_access');
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.calls, [], 'no vault name, no calls');
  } finally {
    t.cleanup();
  }
});

test('the role is not granted for someone other than the recorded operator', { skip: !hasJq }, () => {
  // Another user, and a sign-in that names no user (a service principal: az ad signed-in-user show
  // answers nothing).
  for (const [files, message] of [
    [{ forbidden: '', me: 'someone-else' }, /belongs to the operator op-1, not to you \(someone-else\)/],
    [{ forbidden: '' }, /names no signed-in user to check against its operator op-1/],
  ]) {
    const t = setup(OPERATOR, files);
    try {
      const r = t.run('signin_vault_access');
      assert.notEqual(r.status, 0);
      assert.match(r.err, message);
      assert.equal(r.calls.filter((c) => c.startsWith('deployment')).length, 0);
    } finally {
      t.cleanup();
    }
  }
});

const MICROSOFT = { ATLASRELAY_MICROSOFT_CLIENT_ID: 'app-1', SIGNIN_IDENTITY_PRINCIPAL_ID: 'new-principal' };
const fic = (subject) =>
  JSON.stringify({
    id: 'fic-1',
    name: 'static-web-apps-dev',
    issuer: 'https://login.microsoftonline.com/tenant/v2.0',
    subject,
    audiences: ['api://AzureADTokenExchange'],
  });

test('a rebuilt environment\'s new sign-in identity replaces the old one in the federated credential', { skip: !hasJq }, () => {
  const t = setup(MICROSOFT, { fic: fic('old-principal') });
  try {
    const r = t.run('sync_aad_trust');
    assert.equal(r.status, 0, r.err);
    const patch = r.calls.filter((c) => c.startsWith('rest --method patch'));
    assert.equal(patch.length, 1);
    assert.match(patch[0], /federatedIdentityCredentials\/fic-1 /);
    const body = JSON.parse(patch[0].slice(patch[0].indexOf('--body ') + 7, patch[0].lastIndexOf(' -o none')));
    assert.equal(body.subject, 'new-principal');
    assert.equal(body.name, undefined, 'Graph does not take the name in an update');
    assert.match(r.out, /instead of old-principal/);
  } finally {
    t.cleanup();
  }
});

test('the federated credential is created when missing and left alone when current', { skip: !hasJq }, () => {
  let t = setup(MICROSOFT);
  try {
    const r = t.run('sync_aad_trust');
    assert.equal(r.status, 0, r.err);
    const post = r.calls.filter((c) => c.startsWith('rest --method post'));
    assert.equal(post.length, 1);
    assert.match(post[0], /"subject": "new-principal"/);
  } finally {
    t.cleanup();
  }
  t = setup(MICROSOFT, { fic: fic('new-principal') });
  try {
    const r = t.run('sync_aad_trust');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.calls.filter((c) => /^rest --method (post|patch)/.test(c)).length, 0);
  } finally {
    t.cleanup();
  }
});

test('without a Microsoft registration there is no credential to keep', { skip: !hasJq }, () => {
  const t = setup({ SIGNIN_IDENTITY_PRINCIPAL_ID: 'new-principal' });
  try {
    const r = t.run('sync_aad_trust');
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.calls, []);
  } finally {
    t.cleanup();
  }
});

test('provisioning gets vault access before reading the vault, and fixes the trust after deploying', () => {
  const src = execFileSync('sed', ['-n', '/^provision() {/,/^}/p', ENV_SH], { encoding: 'utf8' });
  const at = (s) => {
    const i = src.indexOf(s);
    assert.notEqual(i, -1, `provision() calls ${s}`);
    return i;
  };
  assert.ok(at('recover_signin_vault') < at('signin_vault_access'));
  assert.ok(at('signin_vault_access') < at('sync_client_ids'));
  assert.ok(at('deploy_stack && save_outputs') < at('sync_aad_trust'));
});
