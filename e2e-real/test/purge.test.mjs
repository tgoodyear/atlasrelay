import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DELETED_ACCOUNT_NAME, TEST_DESCRIPTION_PREFIX, detectTestAccounts, isTestProject, planPurge } from '../lib/purge.mjs';

// Dev as the tests left it: the researcher R posted two test projects and the donor D pledged to
// both; a real person H posted a project of their own, and pledged to one test project; D also
// pledged to H's project.
const proj = (id, ownerId, title, extra = {}) => ({
  partitionKey: 'project', rowKey: id, ownerId, title,
  description: title.startsWith('E2E ') ? `${TEST_DESCRIPTION_PREFIX} (run x).` : 'A real study.',
  creditsConfirmed: 0, ...extra,
});
const rows = () => ({
  projects: [
    proj('t1', 'R', 'E2E full flow aaa', { creditsConfirmed: 250 }),
    proj('t2', 'R', 'E2E real transfer bbb', { creditsConfirmed: 100 }),
    proj('h1', 'H', 'Anycast catchment study', { creditsConfirmed: 40 }),
    { partitionKey: 'owner-R', rowKey: 't1' },
    { partitionKey: 'owner-R', rowKey: 't2' },
    { partitionKey: 'owner-H', rowKey: 'h1' },
  ],
  pledges: [
    { partitionKey: 't1', rowKey: 'p1', donorId: 'D', donorName: DELETED_ACCOUNT_NAME },
    { partitionKey: 't2', rowKey: 'p2', donorId: 'D', donorName: 'E2E donor bbb' },
    { partitionKey: 't2', rowKey: 'p3', donorId: 'H', donorName: 'Helen' },
    { partitionKey: 'h1', rowKey: 'p4', donorId: 'D', donorName: DELETED_ACCOUNT_NAME },
    { partitionKey: 'h1', rowKey: 'p5', donorId: 'X', donorName: 'Xavier' },
  ],
  claims: [
    { partitionKey: 't1', rowKey: 'D' },
    { partitionKey: 'confirm-t2', rowKey: 'lock' },
    { partitionKey: 'receipt-R', rowKey: '991' },
    { partitionKey: 'receipt-H', rowKey: '992' },
    { partitionKey: 'h1', rowKey: 'D' },
    { partitionKey: 'h1', rowKey: 'X' },
    { partitionKey: 'confirm-h1', rowKey: 'lock' },
  ],
});
const keys = (rs) => rs.map((r) => `${r.partitionKey}/${r.rowKey}`).sort();

test('a test project is one titled and described the way the tests write them', () => {
  assert.equal(isTestProject(proj('t', 'R', 'E2E full flow aaa')), true);
  assert.equal(isTestProject({ ...proj('t', 'R', 'E2E full flow aaa'), description: 'hand written' }), false);
  assert.equal(isTestProject(proj('h', 'H', 'Anycast catchment study')), false);
});

test('every spec still writes the description the purge recognises', () => {
  for (const spec of ['full-flow', 'ripe-transfer', 'manual-verify']) {
    const text = readFileSync(new URL(`../specs/${spec}.spec.ts`, import.meta.url), 'utf8');
    assert.ok(text.includes(`description: \`${TEST_DESCRIPTION_PREFIX} (run \${run}).`), spec);
  }
});

test('the test accounts are found from their projects, and a real person who pledged to one is not', () => {
  const found = detectTestAccounts(rows());
  // H pledged to a test project under their own name, so is not a donor candidate at all.
  assert.deepEqual(found, { accounts: ['D', 'R'], skipped: [] });
});

test('an account that owns anything the tests did not post is left for the operator to name', () => {
  const r = rows();
  r.projects.push(proj('r9', 'R', 'My own study'));
  assert.deepEqual(detectTestAccounts(r), { accounts: ['D'], skipped: [{ id: 'R', reason: 'owns 1 project(s) the tests did not post; pass --account with every account to purge, this one included' }] });
  // A test-looking title without the tests' description is not a test project either.
  const r2 = rows();
  r2.projects.push({ ...proj('r8', 'R', 'E2E my own'), description: 'hand written' });
  assert.deepEqual(detectTestAccounts(r2).accounts, ['D']);
});

test('a person who pledged to a test project and later deleted their profile is not taken for the test donor', () => {
  const r = rows();
  // P pledged to a test project and to H's project, then deleted their profile: both rows say Anonymous.
  r.pledges.push({ partitionKey: 't1', rowKey: 'p6', donorId: 'P', donorName: DELETED_ACCOUNT_NAME });
  r.pledges.push({ partitionKey: 'h1', rowKey: 'p7', donorId: 'P', donorName: DELETED_ACCOUNT_NAME });
  const found = detectTestAccounts(r);
  assert.deepEqual(found.accounts, ['D', 'R']);
  assert.deepEqual(found.skipped.map((x) => x.id), ['P']);
  // An Anonymous donor whose every pledge is on a test project is the test donor after a profile deletion.
  const r2 = rows();
  r2.pledges.push({ partitionKey: 't2', rowKey: 'p8', donorId: 'Q', donorName: DELETED_ACCOUNT_NAME });
  assert.deepEqual(detectTestAccounts(r2).accounts, ['D', 'Q', 'R']);
});

test('the plan removes the accounts\' projects with everything under them, and their pledges elsewhere', () => {
  const plan = planPurge(rows(), ['R', 'D']);
  assert.deepEqual(keys(plan.projects), ['project/t1', 'project/t2']);
  assert.deepEqual(keys(plan.index), ['owner-R/t1', 'owner-R/t2']);
  // Everything on the test projects, H's pledge included, and D's pledge on H's project.
  assert.deepEqual(keys(plan.pledges), ['h1/p4', 't1/p1', 't2/p2', 't2/p3']);
  // Slots and locks of the test projects, R's receipts, and D's slot on h1; not X's slot, H's receipts or h1's lock.
  assert.deepEqual(keys(plan.claims), ['confirm-t2/lock', 'h1/D', 'receipt-R/991', 't1/D']);
  // h1 loses a pledge, so its cached totals are rebuilt.
  assert.deepEqual(plan.dirty, ['h1']);
  assert.deepEqual(plan.remaining, { projects: 1, withCredits: 1 });
});

test('the plan touches nothing when no account is given', () => {
  assert.throws(() => planPurge(rows(), []), /No test accounts/);
});

test('the runner refuses prod before it reads anything', () => {
  const sh = readFileSync(new URL('../../scripts/purge-test-data.sh', import.meta.url), 'utf8');
  const mjs = readFileSync(new URL('../../scripts/purge-test-data.mjs', import.meta.url), 'utf8');
  assert.ok(sh.indexOf('refusing to purge prod') < sh.indexOf('. scripts/lib/env.sh'), 'the shell script checks before loading settings');
  assert.ok(mjs.indexOf("if (env === 'prod') die(") < mjs.indexOf('new AzureCliCredential('), 'the runner checks before signing in');
  assert.match(mjs, /account\.startsWith\('statlasrelayprod'\)/);
  // A dry run unless asked.
  assert.match(mjs, /if \(!apply\) \{\n\s+log\('dry run: nothing deleted/);
});
