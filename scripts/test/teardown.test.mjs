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
const BUDGET = `${DEV}/providers/Microsoft.Consumption/budgets/budget-atlasrelay-dev`;
const CNAME = `${SUB}/rg-atlasrelay-prod/providers/Microsoft.Network/dnsZones/atlasrelay.org/CNAME/dev`;
const ROLE = '/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/role-1';
const IDS = [DEV, `${DEV}/providers/Microsoft.Web/staticSites/swa-atlasrelay-dev`, BUDGET, CNAME, ROLE];

// State lives in files in $FAKE: "stack" (the stack exists; "ids" lists what it manages),
// "exists" (one id per line) and "lock-<group>" (that group's lock names). A role that is gone
// answers RoleDefinitionDoesNotExist, a budget that is gone the code 404, the rest
// ResourceNotFound. A group delete takes everything in the group except the budget, and the
// custom role with it, as Azure's did when dev was taken down on 2026-10-12 (#93).
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
    if [ -s "$FAKE/lock-$(cut -d/ -f5 <<< "$id")" ]; then echo "(ScopeLocked) The scope '$id' cannot perform delete operation because following scope(s) are locked." >&2; exit 1; fi
    drop "$id" ;;
  "rest --method get"*)
    id=$(arg --url "$@" | sed 's|^https://management.azure.com||; s|?.*||')
    has "$id" && exit 0
    echo 'Not Found({"error":{"code":"404","message":"Budget not found."}})' >&2
    exit 1 ;;
  "rest --method delete"*) drop "$(arg --url "$@" | sed 's|^https://management.azure.com||; s|?.*||')" ;;
  "group exists"*) has "${SUB}/$(arg -n "$@")" && echo true || echo false ;;
  "group delete"*)
    g="${SUB}/$(arg -n "$@")"
    awk -v g="$g" 'tolower($0) ~ /\\/providers\\/microsoft\\.consumption\\/budgets\\// || (tolower(substr($0, 1, length(g))) != tolower(g) && tolower($0) !~ /\\/roledefinitions\\//)' "$FAKE/exists" > "$FAKE/exists.tmp"
    mv "$FAKE/exists.tmp" "$FAKE/exists" ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 1 ;;
esac
`;
const FAKE_GH = `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$FAKE/calls"
`;

function setup({ stack = true, ids = IDS, exists = ids, locks = {}, resume } = {}) {
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
  for (const [g, names] of Object.entries(locks)) writeFileSync(join(fake, `lock-${g}`), `${names.join('\n')}\n`);
  const run = () => {
    const r = spawnSync('bash', [join(dir, 'scripts', 'teardown.sh'), 'dev'], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake },
      input: 'dev\n',
      encoding: 'utf8',
    });
    const calls = existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [];
    const left = readFileSync(join(fake, 'exists'), 'utf8').trim().split('\n').filter(Boolean);
    return { status: r.status, out: r.stdout, err: r.stderr, calls, left };
  };
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROD_LOCK = { 'rg-atlasrelay-prod': ['prod-cannot-delete'] };

test('a teardown deletes the budget before its group, and passes over the role the group took', { skip: !hasJq }, () => {
  const t = setup({ locks: PROD_LOCK });
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /deleted environment dev/);
    assert.deepEqual(r.left, [CNAME], 'only the CNAME under prod\'s lock is left');
    const budget = r.calls.indexOf(`rest --method delete --url https://management.azure.com${BUDGET}?api-version=2023-11-01 -o none`);
    assert.ok(budget >= 0, 'the budget is deleted');
    assert.ok(budget < r.calls.findIndex((c) => c.startsWith('group delete')), 'before the group');
    assert.ok(r.calls.includes(`resource show --ids ${ROLE} -o none`));
    assert.ok(!r.calls.includes(`resource delete --ids ${ROLE} -o none`), 'the role went with the group');
  } finally {
    t.cleanup();
  }
});

test('a resumed run passes over the role and budget already gone', { skip: !hasJq }, () => {
  // The first run stopped after the group delete: the stack is detached, and the role went with
  // the group.
  const t = setup({ stack: false, exists: [CNAME], locks: PROD_LOCK, resume: IDS });
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /resuming an interrupted teardown/);
    assert.ok(r.calls.includes(`resource show --ids ${ROLE} -o none`));
    assert.ok(r.calls.some((c) => c.startsWith('rest --method get') && c.includes(BUDGET)));
    assert.equal(r.calls.filter((c) => /^(resource delete|rest --method delete|group delete)/.test(c)).length, 0);
    assert.match(r.out, /deleted environment dev/);
  } finally {
    t.cleanup();
  }
});
