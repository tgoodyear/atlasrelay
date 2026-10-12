// scripts/teardown.sh, run in bash against a fake az and gh that record their calls. Nothing
// reaches Azure or GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const hasJq = spawnSync('jq', ['--version']).status === 0;

const SUB = '/subscriptions/sub/resourceGroups';
const DEV = `${SUB}/rg-atlasrelay-dev`;
const CNAME = `${SUB}/rg-atlasrelay-prod/providers/Microsoft.Network/dnsZones/atlasrelay.org/CNAME/dev`;
const ROLE = '/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/role-1';
const IDS = [DEV, `${DEV}/providers/Microsoft.Web/staticSites/swa-atlasrelay-dev`, CNAME, ROLE];

// State lives in files in $FAKE: "stack" (the stack exists; "ids" lists what it manages),
// "exists" (one id per line), "lock-<group>" (that group's lock levels) and "cname" (the dev
// record's target). A delete in a group with a lock fails, as Azure's does. A role that is gone
// answers RoleDefinitionDoesNotExist, the rest ResourceNotFound.
const FAKE_AZ = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE/calls"
has() { grep -qixF "$1" "$FAKE/exists" 2> /dev/null; }
drop() { grep -vixF "$1" "$FAKE/exists" > "$FAKE/exists.tmp" || true; mv "$FAKE/exists.tmp" "$FAKE/exists"; }
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$*" in
  "stack sub create --help") echo "  --action-on-unmanage" ;;
  "account show"*) ;;
  "stack sub show"*)
    [ -f "$FAKE/stack" ] || { echo "(DeploymentStackNotFound) The deployment stack could not be found." >&2; exit 1; }
    case "$*" in *--query*) cat "$FAKE/ids" ;; esac ;;
  "stack sub delete"*) rm "$FAKE/stack" ;;
  "lock list -g"*) cat "$FAKE/lock-$(arg -g "$@")" 2> /dev/null || true ;;
  "lock list"*) ;;
  "resource show"*)
    id=$(arg --ids "$@")
    has "$id" && exit 0
    case "$id" in
      */roleDefinitions/*) echo "(RoleDefinitionDoesNotExist) The specified role definition with ID 'role-1' does not exist." >&2 ;;
      *) echo "(ResourceNotFound) The Resource '$id' was not found." >&2 ;;
    esac
    exit 1 ;;
  "resource delete"*)
    id=$(arg --ids "$@")
    g=$(cut -d/ -f5 <<< "$id")
    if [ -s "$FAKE/lock-$g" ]; then echo "(ScopeLocked) The scope '$id' cannot perform delete operation because following scope(s) are locked." >&2; exit 1; fi
    drop "$id" ;;
  "network dns record-set cname show"*) cat "$FAKE/cname" ;;
  "network dns record-set cname remove-record"*) : > "$FAKE/cname" ;;
  "group exists"*) has "${SUB}/$(arg -n "$@")" && echo true || echo false ;;
  "group delete"*) g=$(arg -n "$@"); grep -viF "${SUB}/$g" "$FAKE/exists" > "$FAKE/exists.tmp" || true; mv "$FAKE/exists.tmp" "$FAKE/exists" ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 1 ;;
esac
`;
const FAKE_GH = `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$FAKE/calls"
`;

function setup({ stack = true, ids = IDS, exists = ids, locks = {}, cname = 'swa-dev.azurestaticapps.net', resume } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
  const bin = join(dir, 'bin');
  const fake = join(dir, 'fake');
  for (const d of [bin, fake, join(dir, 'scripts', 'lib'), join(dir, '.azure', 'dev')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(SCRIPTS, 'teardown.sh'), join(dir, 'scripts', 'teardown.sh'));
  copyFileSync(join(SCRIPTS, 'lib', 'env.sh'), join(dir, 'scripts', 'lib', 'env.sh'));
  for (const [name, body] of [['az', FAKE_AZ], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, '.azure', 'dev', '.env'), 'AZURE_SUBSCRIPTION_ID="sub"\n');
  if (resume) writeFileSync(join(dir, '.azure', 'dev', 'teardown-sub.ids'), `${resume.join('\n')}\n`);
  if (stack) writeFileSync(join(fake, 'stack'), '');
  writeFileSync(join(fake, 'ids'), `${ids.join('\n')}\n`);
  writeFileSync(join(fake, 'exists'), `${exists.join('\n')}\n`);
  writeFileSync(join(fake, 'cname'), `${cname}\n`);
  for (const [g, levels] of Object.entries(locks)) writeFileSync(join(fake, `lock-${g}`), `${levels.join('\n')}\n`);
  const run = () => {
    const r = spawnSync('bash', [join(dir, 'scripts', 'teardown.sh'), 'dev'], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake },
      input: 'dev\n',
      encoding: 'utf8',
    });
    const calls = existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [];
    const left = readFileSync(join(fake, 'exists'), 'utf8').trim().split('\n').filter(Boolean);
    return { status: r.status, out: r.stdout, err: r.stderr, calls, left, cname: readFileSync(join(fake, 'cname'), 'utf8').trim() };
  };
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROD_LOCK = { 'rg-atlasrelay-prod': ['CanNotDelete'] };

test('dev tears down under prod\'s delete lock, its CNAME emptied before the site goes', { skip: !hasJq }, () => {
  const t = setup({ locks: PROD_LOCK });
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /The record dev in the DNS zone atlasrelay\.org is emptied, not deleted/);
    assert.match(r.out, /deleted environment dev/);
    assert.equal(r.cname, '', 'the record points nowhere');
    assert.deepEqual(r.left, [CNAME], 'only the record set is left');
    assert.equal(r.calls.filter((c) => c.startsWith('resource delete') && c.includes('/CNAME/')).length, 0);
    const empty = r.calls.findIndex((c) => c.startsWith('network dns record-set cname remove-record'));
    assert.match(r.calls[empty], /-g rg-atlasrelay-prod -z atlasrelay\.org -n dev .*-c swa-dev\.azurestaticapps\.net --keep-empty-record-set/);
    assert.ok(empty < r.calls.findIndex((c) => c.startsWith('group delete')), 'emptied before the group goes');
  } finally {
    t.cleanup();
  }
});

test('without a lock on prod\'s group the CNAME is deleted', { skip: !hasJq }, () => {
  const t = setup();
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.left, []);
    assert.ok(r.calls.includes(`resource delete --ids ${CNAME} -o none`));
    assert.doesNotMatch(r.out, /emptied/);
  } finally {
    t.cleanup();
  }
});

test('a ReadOnly lock, or a lock over anything but a CNAME, stops before anything changes', { skip: !hasJq }, () => {
  const TXT = `${SUB}/rg-atlasrelay-prod/providers/Microsoft.Network/dnsZones/atlasrelay.org/TXT/dev`;
  for (const opts of [{ locks: { 'rg-atlasrelay-prod': ['CanNotDelete', 'ReadOnly'] } }, { locks: PROD_LOCK, ids: [...IDS, TXT] }]) {
    const t = setup(opts);
    try {
      const r = t.run();
      assert.notEqual(r.status, 0);
      assert.match(r.err, /rg-atlasrelay-prod, which has management locks .*Nothing has been changed/s);
      assert.equal(r.calls.filter((c) => /^(stack sub delete|resource delete|network dns|group delete|gh variable)/.test(c)).length, 0);
    } finally {
      t.cleanup();
    }
  }
});

test('a resumed run passes over the role already gone with the group, and an emptied CNAME', { skip: !hasJq }, () => {
  // The first run stopped after the group delete: the stack is detached and the record emptied.
  const t = setup({ stack: false, exists: [CNAME], locks: PROD_LOCK, cname: '', resume: IDS });
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /resuming an interrupted teardown/);
    assert.ok(r.calls.includes(`resource show --ids ${ROLE} -o none`));
    assert.equal(r.calls.filter((c) => /^(resource delete|network dns record-set cname remove-record)/.test(c)).length, 0);
    assert.match(r.out, /deleted environment dev/);
  } finally {
    t.cleanup();
  }
});
