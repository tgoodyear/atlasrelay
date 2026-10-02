import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpRequest } from '@azure/functions';
import { HttpError } from '../src/lib/http';
import { CLAIM_ORPHAN_GRACE_MS, type Pledge, type Project } from '../src/lib/store';
import { TEST_CLEANUP_ROUTE, TEST_CLEANUP_SETTING, deleteTestProject, marksTestProject, testCleanupEnabled, type TestCleanupStore } from '../src/lib/testCleanup';
import { registerTestCleanup } from '../src/functions/testCleanup';
import { publicProject } from '../src/lib/views';

const ON = { [TEST_CLEANUP_SETTING]: '1' };
const OWNER = { identityProvider: 'aad', userId: 'owner1', userDetails: 'researcher', userRoles: ['anonymous', 'authenticated'] };
const OTHER = { ...OWNER, userId: 'other1' };
const ID = '0000000000abcdefgh';

function request(principal?: object, id = ID): HttpRequest {
  const headers: Record<string, string> = {};
  if (principal) headers['x-ms-client-principal'] = Buffer.from(JSON.stringify(principal)).toString('base64');
  return new HttpRequest({ method: 'DELETE', url: `https://example.org/api/test/projects/${id}`, headers, params: { id } });
}

/** Closed for deletion long enough ago that no pledge request can still be running. */
const LONG_AGO = '2026-01-01T00:00:00.000Z';

const project = (over: Partial<Project> = {}): Project => ({
  id: ID, ownerId: 'owner1', ownerName: 'E2E researcher', title: 'E2E full flow abc', summary: 's', description: 'd',
  creditsRequested: 100, creditsConfirmed: 100, creditsPending: 0, tags: [],
  affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
  resultsSummary: '', resultsUrl: '', resultsPostedAt: '',
  moderationClosed: false, createdAt: '', updatedAt: '', createdByTests: true,
  status: 'closed', deletingSince: LONG_AGO,
  ...over,
});

const pledge = (over: Partial<Pledge> = {}): Pledge => ({
  id: 'p1', projectId: ID, donorId: 'd1', donorName: 'E2E donor', anonymous: false, amount: 100, method: 'manual',
  status: 'confirmed', transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false,
  inFlight: false, inFlightSince: '', receivedAmount: 0, amountVerified: false, message: '',
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

/** A store that records what was asked of it. */
function fakeStore(row: Project | null, pledges: Pledge[] = [], slots: { donorId: string; pledgeId: string; createdAt: string }[] = []) {
  const calls: string[] = [];
  const store: TestCleanupStore = {
    getProject: async (id) => { calls.push(`get ${id}`); return row; },
    listPledges: async (id) => { calls.push(`pledges ${id}`); return pledges; },
    listPledgeSlots: async (id) => { calls.push(`slots ${id}`); return slots; },
    beginDeletion: async (id) => { calls.push(`close ${id}`); },
    deleteProjectRecords: async (p) => { calls.push(`delete ${p.id} ${p.ownerId}`); return { pledges: pledges.length, claims: 2 }; },
  };
  return { store, calls };
}

/** A store that fails the test if anything reads it. */
const untouchable: TestCleanupStore = {
  getProject: async () => assert.fail('read a project'),
  listPledges: async () => assert.fail('read pledges'),
  listPledgeSlots: async () => assert.fail('read slots'),
  beginDeletion: async () => assert.fail('closed a project'),
  deleteProjectRecords: async () => assert.fail('deleted something'),
};

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
    return err.status;
  }
}

test('the setting is on only when it is exactly 1', () => {
  assert.equal(testCleanupEnabled({}), false);
  for (const v of ['', '0', 'true', 'yes', ' 1', '1 ', 'TRUE']) assert.equal(testCleanupEnabled({ [TEST_CLEANUP_SETTING]: v }), false, v);
  assert.equal(testCleanupEnabled(ON), true);
});

test('without the setting the route is never registered', () => {
  const registered: string[] = [];
  assert.equal(registerTestCleanup({}, (name) => registered.push(name)), false);
  assert.equal(registerTestCleanup({ [TEST_CLEANUP_SETTING]: '0' }, (name) => registered.push(name)), false);
  assert.deepEqual(registered, []);
});

test('with the setting the route is registered for DELETE under /api/test only', () => {
  const registered: { name: string; route?: string; methods?: string[] }[] = [];
  assert.equal(registerTestCleanup(ON, (name, o) => registered.push({ name, route: o.route, methods: o.methods })), true);
  assert.deepEqual(registered, [{ name: 'test-project-delete', route: 'test/projects/{id}', methods: ['DELETE'] }]);
  assert.equal(TEST_CLEANUP_ROUTE.startsWith('test/'), true);
});

test('without the setting the handler answers 404 before reading the request or storage', async () => {
  // The owner of a marked project, who would be allowed on dev, gets the same 404 as a missing route.
  assert.equal(await status(deleteTestProject(request(OWNER), untouchable, {})), 404);
  assert.equal(await status(deleteTestProject(request(), untouchable, {})), 404);
  assert.equal(await status(deleteTestProject(request(OWNER), untouchable, { [TEST_CLEANUP_SETTING]: 'true' })), 404);
});

test('a signed-out caller is refused before storage is read', async () => {
  assert.equal(await status(deleteTestProject(request(), untouchable, ON)), 401);
  // An unlinked app treats every request as anonymous, this one included.
  assert.equal(await status(deleteTestProject(request(OWNER), untouchable, { ...ON, IGNORE_CLIENT_PRINCIPAL: '1' })), 401);
});

test('a malformed id or a missing project is 404', async () => {
  assert.equal(await status(deleteTestProject(request(OWNER, 'NOT-AN-ID'), untouchable, ON)), 404);
  const { store, calls } = fakeStore(null);
  assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 404);
  assert.deepEqual(calls, [`get ${ID}`]);
});

test('only the project owner may delete it', async () => {
  const { store, calls } = fakeStore(project());
  assert.equal(await status(deleteTestProject(request(OTHER), store, ON)), 403);
  assert.deepEqual(calls, [`get ${ID}`], 'nothing closed, nothing deleted');
});

test('only a project marked at creation may be deleted, even by its owner', async () => {
  for (const row of [project({ createdByTests: undefined }), project({ createdByTests: false }), project({ createdByTests: 'true' as unknown as boolean })]) {
    const { store, calls } = fakeStore(row);
    assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 403);
    assert.equal(calls.some((c) => c.startsWith('delete')), false);
  }
  // A test-looking title is not the marker: an owner could rename any project to that.
  const { store, calls } = fakeStore(project({ createdByTests: undefined, title: 'E2E renamed' }));
  assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 403);
  assert.equal(calls.some((c) => c.startsWith('delete')), false);
});

test('the first call closes the project and deletes nothing', async () => {
  for (const row of [project({ status: 'open', deletingSince: undefined }), project({ deletingSince: undefined }), project({ status: 'open' })]) {
    // Open, closed by someone else, or reopened after a first call: each starts the wait.
    const { store, calls } = fakeStore(row);
    assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 409);
    assert.deepEqual(calls, [`get ${ID}`, `close ${ID}`]);
  }
});

test('the project is deleted only once it has been closed for longer than any pledge request runs', async () => {
  // A pledge request that read the project as open just before the close may still take a slot and
  // transfer. The grace is the bound every claim in the store already relies on.
  const justNow = new Date(Date.now() - CLAIM_ORPHAN_GRACE_MS + 10_000).toISOString();
  const { store, calls } = fakeStore(project({ deletingSince: justNow }));
  assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 409);
  assert.deepEqual(calls, [`get ${ID}`], 'neither closed again nor deleted');
  const after = new Date(Date.now() - CLAIM_ORPHAN_GRACE_MS - 1_000).toISOString();
  const later = fakeStore(project({ deletingSince: after }));
  assert.equal(await status(deleteTestProject(request(OWNER), later.store, ON)), 200);
});

test('a project with a transfer still in flight is not deleted', async () => {
  const running = pledge({ method: 'api', status: 'pledged', inFlight: true, inFlightSince: new Date().toISOString() });
  const { store, calls } = fakeStore(project(), [pledge({ id: 'p0' }), running]);
  assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 409);
  assert.equal(calls.some((c) => c.startsWith('delete')), false);
});

test('a slot taken moments ago with no pledge row yet is a request in progress', async () => {
  const fresh = { donorId: 'd9', pledgeId: 'p9', createdAt: new Date().toISOString() };
  const { store, calls } = fakeStore(project(), [pledge()], [fresh]);
  assert.equal(await status(deleteTestProject(request(OWNER), store, ON)), 409);
  assert.equal(calls.some((c) => c.startsWith('delete')), false);
});

test('the owner of a marked project deletes it with everything under it', async () => {
  // An in-flight marker older than the grace window is a dead request, not a running transfer, and
  // so is an old slot with no row behind it. A recent slot whose pledge row exists is settled.
  const stale = pledge({ id: 'p2', method: 'api', status: 'confirmed', inFlight: true, inFlightSince: '2026-01-01T00:00:00.000Z' });
  const slots = [
    { donorId: 'd1', pledgeId: 'p1', createdAt: new Date().toISOString() },
    { donorId: 'd8', pledgeId: 'gone', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const { store, calls } = fakeStore(project(), [pledge(), stale], slots);
  const result = await deleteTestProject(request(OWNER), store, ON);
  assert.deepEqual(result, { deleted: ID, pledges: 2, claims: 2 });
  assert.deepEqual(calls, [`get ${ID}`, `pledges ${ID}`, `slots ${ID}`, `delete ${ID} owner1`]);
});

test('a project is marked at creation only on a test environment, and only with the test title prefix', () => {
  assert.equal(marksTestProject('E2E full flow abc', {}), false);
  assert.equal(marksTestProject('E2E full flow abc', { [TEST_CLEANUP_SETTING]: '0' }), false);
  assert.equal(marksTestProject('E2E full flow abc', ON), true);
  assert.equal(marksTestProject('Anycast catchment study', ON), false);
  assert.equal(marksTestProject('e2e lower case', ON), false);
  assert.equal(marksTestProject('E2Eno space', ON), false);
});

test('the marker and the deletion stamp are never published', () => {
  const p = publicProject(project());
  assert.equal('createdByTests' in p, false);
  assert.equal('deletingSince' in p, false);
});

// ---------- the prod gate in Bicep ----------
//
// scripts/check-params.sh compiles the templates and checks the evaluated parameters: prod resolves
// testHarness to false, and the compiled module passes `harness` to the API. These read the
// sources, so a change that moves the setting somewhere else fails here before it is ever deployed.

const repoRoot = join(process.cwd(), '..');
const infra = (f: string) => readFileSync(join(repoRoot, 'infra', f), 'utf8');

test('only api.bicep writes the cleanup setting, and only when its testCleanup parameter is true', () => {
  const writers = readdirSync(join(repoRoot, 'infra')).filter((f) => f.endsWith('.bicep') || f.endsWith('.bicepparam')).filter((f) => infra(f).includes(TEST_CLEANUP_SETTING));
  assert.deepEqual(writers, ['api.bicep']);
  const api = infra('api.bicep');
  assert.match(api, /^param testCleanup bool = false$/m, 'off unless the caller says otherwise');
  assert.match(api, new RegExp(`^var testCleanupAppSettings = testCleanup \\? \\{ ${TEST_CLEANUP_SETTING}: '1' \\} : \\{\\}$`, 'm'));
  // additionalAppSettings cannot carry it into prod either: the key is filtered out of it.
  assert.match(api, new RegExp(`^var extraAppSettings = toObject\\(filter\\(items\\(additionalAppSettings\\), s => toUpper\\(s\\.key\\) != '${TEST_CLEANUP_SETTING}'\\)`, 'm'));
  assert.match(api, /properties: union\(baseAppSettings, monitoringAppSettings, unlinkedAppSettings, extraAppSettings, testCleanupAppSettings\)/);
  assert.doesNotMatch(api, /union\([^)]*\badditionalAppSettings\b/, 'the unfiltered map is never applied');
});

test('main.bicep turns cleanup on only for a non-prod environment', () => {
  const main = infra('main.bicep');
  assert.match(main, /^var isProd = env == 'prod'$/m);
  assert.match(main, /^var harness = testHarness && !isProd$/m);
  // Exactly one module parameter, and it is the harness flag, which is false in prod whatever testHarness says.
  assert.deepEqual(main.match(/^\s*testCleanup: .*$/gm)?.map((l) => l.trim()), ['testCleanup: harness']);
});
