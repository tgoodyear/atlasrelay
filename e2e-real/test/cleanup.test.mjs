import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WAIT_RETRIES, TEST_TITLE_PREFIX, deleteRunProjects, runProjects } from '../lib/cleanup.mjs';

const RUN = 'abc123def456';
const projects = [
  { id: 'p1', title: `E2E full flow ${RUN}` },
  { id: 'p2', title: `E2E real transfer ${RUN}` },
  { id: 'p3', title: 'E2E full flow 999999999999' },
  { id: 'p4', title: `Anycast study ${RUN}` },
  { id: 'p5', title: `E2E short balance ${RUN}x` },
];

/**
 * A site whose DELETE answers from `answers` (one status per call, per id, the last repeating) and
 * which still has every id in `present` for the read-back (or answers `reads[id]` to it).
 * @param {Record<string, number[]>} answers
 * @param {Set<string>} [present]
 */
function site(answers, present = new Set(), /** @type {Record<string, number>} */ reads = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {number[]} */
  const waits = [];
  const io = {
    list: async () => projects,
    remove: async (/** @type {string} */ id) => {
      calls.push(id);
      const q = answers[id] ?? [200];
      return q.length > 1 ? /** @type {number} */ (q.shift()) : q[0];
    },
    read: async (/** @type {string} */ id) => (reads[id] ?? (present.has(id) ? 200 : 404)),
    log: (/** @type {string} */ line) => lines.push(line),
    wait: async (/** @type {number} */ ms) => { waits.push(ms); },
  };
  return { io, calls, lines, waits };
}

test('a run deletes only the projects it titled with its own run id', () => {
  assert.deepEqual(runProjects(projects, RUN).map((p) => p.id), ['p1', 'p2']);
  assert.throws(() => runProjects(projects, ''), /No run id/);
});

test('the prefix matches the one the API marks test projects by', () => {
  const api = readFileSync(new URL('../../api/src/lib/testCleanup.ts', import.meta.url), 'utf8');
  assert.match(api, new RegExp(`export const TEST_TITLE_PREFIX = '${TEST_TITLE_PREFIX}';`));
});

test('every spec titles its projects so the run can find them, and cleans up after the credit return', () => {
  for (const spec of ['full-flow', 'ripe-transfer', 'manual-verify']) {
    const text = readFileSync(new URL(`../specs/${spec}.spec.ts`, import.meta.url), 'utf8');
    // Titles end in the run id.
    for (const m of text.matchAll(/title: `([^`]*)`/g)) assert.match(m[1], /^E2E .*\$\{run\}$/, `${spec}: ${m[1]}`);
    // The cleanup hook is declared after the credit return (where there is one) and before the profiles go.
    const cleanup = text.search(/test\.after(Each|All)\(async \(\{\}, testInfo\) => cleanUpRun\(run, testInfo(, \{ wait: false \})?\)\);/);
    const profiles = text.search(/test\.after(Each|All)\(deleteBothProfiles\);/);
    assert.ok(cleanup > 0 && profiles > cleanup, `${spec}: cleanup must be declared before the profile deletion`);
    const creditReturn = text.indexOf('await sendBack(');
    if (creditReturn >= 0) {
      assert.ok(creditReturn < cleanup, `${spec}: cleanup must be declared after the credit return`);
      // A timed-out afterEach skips the hooks after it, so the same cleanup runs again in afterAll.
      assert.match(text, /test\.afterAll\(async \(\{\}, testInfo\) => cleanUpRun\(run, testInfo\)\);\ntest\.afterAll\(deleteBothProfiles\);/, `${spec}: no afterAll safety net`);
    }
  }
});

test('the run deletes its projects and logs their ids only', async () => {
  const { io, calls, lines } = site({});
  assert.deepEqual(await deleteRunProjects(io, RUN), ['p1', 'p2']);
  assert.deepEqual(calls, ['p1', 'p2']);
  assert.deepEqual(lines, ['[cleanup] deleted 2 project(s): p1, p2']);
  assert.equal(lines.join('\n').includes('full flow'), false, 'no titles in the output');
});

test('a run that posted nothing says so', async () => {
  const { io, lines } = site({});
  io.list = async () => [];
  assert.deepEqual(await deleteRunProjects(io, RUN), []);
  assert.deepEqual(lines, ['[cleanup] deleted 0 project(s)']);
});

test('a project already gone is not an error', async () => {
  const { io } = site({ p1: [404] });
  assert.deepEqual(await deleteRunProjects(io, RUN), ['p2']);
});

test('an environment without the route fails the run and says why', async () => {
  const { io, calls } = site({ p1: [404], p2: [404] }, new Set(['p1', 'p2']));
  await assert.rejects(deleteRunProjects(io, RUN), /2 project\(s\) not deleted: p1 \(HTTP 404: this environment has no cleanup route.*p2/);
  assert.deepEqual(calls, ['p1', 'p2'], 'it still tries every project');
});

test('a 404 followed by a failed read is not taken as gone', async () => {
  const { io } = site({ p1: [404] }, new Set(), { p1: 503 });
  await assert.rejects(deleteRunProjects(io, RUN), /p1 \(HTTP 404, then HTTP 503 reading it back\)/);
});

test('a refusal fails the run after trying the rest', async () => {
  const { io, calls, lines } = site({ p1: [403] });
  await assert.rejects(deleteRunProjects(io, RUN), /1 project\(s\) not deleted: p1 \(HTTP 403\)/);
  assert.deepEqual(calls, ['p1', 'p2']);
  assert.deepEqual(lines, ['[cleanup] deleted 1 project(s): p2']);
});

test('the close is waited out, then the project is deleted', async () => {
  const { io, calls, waits, lines } = site({ p1: [409, 409, 200] });
  assert.deepEqual(await deleteRunProjects(io, RUN), ['p1', 'p2']);
  assert.deepEqual(calls, ['p1', 'p1', 'p1', 'p2']);
  assert.equal(waits.length, 2);
  assert.equal(lines[0], '[cleanup] project p1 is closed; deleting it once no pledge to it can still be running');
});

test('without waiting, a 409 starts the close and is not an error', async () => {
  const { io, calls, waits } = site({ p1: [409], p2: [200] });
  assert.deepEqual(await deleteRunProjects(io, RUN, { wait: false }), ['p2']);
  assert.deepEqual(calls, ['p1', 'p2']);
  assert.equal(waits.length, 0);
  // Anything else still fails.
  const other = site({ p1: [403] });
  await assert.rejects(deleteRunProjects(other.io, RUN, { wait: false }), /p1 \(HTTP 403\)/);
});

test('the retries outlast the two minutes the API waits after closing', async () => {
  const { WAIT_MS } = await import('../lib/cleanup.mjs');
  const store = readFileSync(new URL('../../api/src/lib/store.ts', import.meta.url), 'utf8');
  const grace = Number(store.match(/export const CLAIM_ORPHAN_GRACE_MS = (\d+) \* (\d+) \* (\d+);/)?.slice(1).reduce((a, b) => a * Number(b), 1));
  assert.equal(grace, 120_000);
  assert.ok(WAIT_RETRIES * WAIT_MS >= grace + 30_000, 'at least 30 s to spare');
});

test('a transfer that stays in flight gives up after the retries and fails the run', async () => {
  const { io, calls } = site({ p1: [409] });
  await assert.rejects(deleteRunProjects(io, RUN), /p1 \(HTTP 409\)/);
  assert.equal(calls.filter((c) => c === 'p1').length, WAIT_RETRIES + 1);
});
