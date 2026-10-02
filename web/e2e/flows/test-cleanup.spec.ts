import { allRows, deleteRow, expect, postProject, putRow, row, test, type Person } from './fixtures';

// DELETE /api/test/projects/{id}: how the full-flow tests on dev remove the projects they post. The
// local stack turns it on the way Bicep does outside prod (E2E_PROJECT_CLEANUP=1). That the route
// does not exist without the setting is covered by the API's unit tests and scripts/check-params.sh.

const cleanup = (who: { request: Person['request'] }, id: string) => who.request.delete(`/api/test/projects/${id}`);

/**
 * Move the project's deletion stamp back past the two minutes the API waits after closing it, as if
 * that time had passed.
 */
async function backdateDeletion(id: string): Promise<void> {
  const stored = await row('projects', 'project', id);
  expect(stored?.deletingSince, 'the first call stamped the project').toBeTruthy();
  const { etag: _etag, timestamp: _timestamp, ...rest } = stored as Record<string, unknown> & { partitionKey: string; rowKey: string };
  await putRow('projects', { ...rest, deletingSince: '2026-01-01T00:00:00.000Z' });
}

/** The two calls the route needs: the first closes the project, the second (after the wait) deletes it. */
async function closeThenDelete(who: { request: Person['request'] }, id: string) {
  const first = await cleanup(who, id);
  expect(first.status(), await first.text()).toBe(409);
  expect((await row('projects', 'project', id))?.status).toBe('closed');
  // Inside the wait, it still refuses and does not restart the wait.
  const stamp = (await row('projects', 'project', id))?.deletingSince;
  expect((await cleanup(who, id)).status()).toBe(409);
  expect((await row('projects', 'project', id))?.deletingSince).toBe(stamp);
  await backdateDeletion(id);
  return cleanup(who, id);
}

/** Every stored row that names the project, in any table. */
async function rowsNaming(id: string): Promise<string[]> {
  const out: string[] = [];
  for (const [table, rows] of Object.entries(await allRows())) {
    for (const r of rows) {
      if ([r.partitionKey, r.rowKey, r.projectId].some((v) => typeof v === 'string' && v.includes(id))) {
        out.push(`${table} ${String(r.partitionKey)}/${String(r.rowKey)}`);
      }
    }
  }
  return out.sort();
}

test('the owner deletes a test project with its pledges, claims, lock, receipts and index entry', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const other = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 50 });
  const keep = await postProject(other);

  // A confirmed pledge with results, as a full-flow run leaves it, and a second pledge still waiting.
  const pledged = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 50, method: 'manual' } });
  expect(pledged.status(), await pledged.text()).toBe(201);
  const pledgeId = (await pledged.json()).pledge.id as string;
  expect((await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'confirmed' } })).status()).toBe(200);
  expect((await researcher.request.patch(`/api/projects/${project.id}`, { data: { resultsSummary: 'Done.' } })).status()).toBe(200);
  const waiting = await other.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 5, method: 'manual' } });
  expect(waiting.status(), await waiting.text()).toBe(201);
  // What a checked confirmation and a crashed one leave behind: a receipt reservation naming this
  // project, and a confirmation lock. A reservation naming another project of the same owner stays.
  await putRow('claims', { partitionKey: `receipt-${researcher.id}`, rowKey: '990001', projectId: project.id, pledgeId, token: 't', createdAt: new Date().toISOString() });
  await putRow('claims', { partitionKey: `receipt-${researcher.id}`, rowKey: '990002', projectId: keep.id, pledgeId: 'x', token: 't', createdAt: new Date().toISOString() });
  await putRow('claims', { partitionKey: `confirm-${project.id}`, rowKey: 'lock', token: 't', createdAt: new Date().toISOString() });

  // The confirmed pledge has given its donor's slot back; the waiting one still holds its slot.
  const waitingId = (await waiting.json()).pledge.id as string;
  expect(await rowsNaming(project.id)).toEqual([
    `claims ${project.id}/${other.id}`,
    `claims confirm-${project.id}/lock`,
    `claims receipt-${researcher.id}/990001`,
    `pledges ${project.id}/${pledgeId}`,
    `pledges ${project.id}/${waitingId}`,
    `projects owner-${researcher.id}/${project.id}`,
    `projects project/${project.id}`,
  ].sort());

  const res = await closeThenDelete(researcher, project.id);
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toEqual({ deleted: project.id, pledges: 2, claims: 3 });

  expect(await rowsNaming(project.id)).toEqual([]);
  // Nothing else went with it.
  expect(await row('projects', 'project', keep.id)).not.toBeNull();
  expect(await row('claims', `receipt-${researcher.id}`, '990002')).not.toBeNull();
  expect(await row('users', 'user', researcher.id)).not.toBeNull();

  // Gone from every read: the project, the listing and the owner's dashboard.
  const visitor = await signedOut();
  expect((await visitor.request.get(`/api/projects/${project.id}`)).status()).toBe(404);
  const listed = (await (await visitor.request.get('/api/projects?status=all')).json()).projects as { id: string }[];
  expect(listed.map((p) => p.id)).not.toContain(project.id);
  expect(listed.map((p) => p.id)).toContain(keep.id);
  const mine = (await (await researcher.request.get('/api/my')).json()) as { projects: { id: string }[] };
  expect(mine.projects).toEqual([]);

  // Deleting it again finds nothing.
  expect((await cleanup(researcher, project.id)).status()).toBe(404);
});

test('nobody but the owner, and nothing the tests did not post, can be deleted', async ({ person, signedOut }) => {
  const researcher = await person({ role: 'researcher' });
  const stranger = await person({ role: 'donor' });
  const writer = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  // Posted without the test title, so never marked, and renaming it afterwards does not mark it.
  const real = await postProject(writer, { title: 'Anycast catchment study' });
  expect((await writer.request.patch(`/api/projects/${real.id}`, { data: { title: 'E2E renamed' } })).status()).toBe(200);
  expect((await row('projects', 'project', project.id))?.createdByTests).toBe(true);
  expect((await row('projects', 'project', real.id))?.createdByTests).toBeUndefined();

  const visitor = await signedOut();
  expect((await cleanup(visitor, project.id)).status()).toBe(401);
  expect((await cleanup(stranger, project.id)).status()).toBe(403);
  expect((await cleanup(writer, real.id)).status()).toBe(403);
  expect((await cleanup(researcher, 'NOT-AN-ID')).status()).toBe(404);

  // The marker is never published.
  const body = await (await visitor.request.get(`/api/projects/${project.id}`)).text();
  expect(body).not.toContain('createdByTests');

  expect(await row('projects', 'project', project.id)).not.toBeNull();
  expect(await row('projects', 'project', real.id)).not.toBeNull();
});

test('the first call closes the project, so no pledge can start or move on', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher);
  const before = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 5, method: 'manual' } });
  expect(before.status(), await before.text()).toBe(201);
  const pledgeId = (await before.json()).pledge.id as string;
  expect((await cleanup(researcher, project.id)).status()).toBe(409);
  const pledge = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 5, method: 'manual' } });
  expect(pledge.status()).toBe(409);
  // Nor can a pledge already on it be moved on: the deletion would remove it from under the request.
  expect((await donor.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'sent' } })).status()).toBe(409);
  expect((await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'confirmed' } })).status()).toBe(409);
  expect((await row('pledges', project.id, pledgeId))?.status).toBe('pledged');
  // It cannot be reopened while the cleanup waits, so the stamp stands for an unbroken closed period.
  const reopen = await researcher.request.patch(`/api/projects/${project.id}`, { data: { status: 'open' } });
  expect(reopen.status(), await reopen.text()).toBe(409);
  expect((await row('projects', 'project', project.id))?.status).toBe('closed');
  // A reopen that got in anyway (one that read the project before it was stamped) leaves it open,
  // and the next call starts the wait again rather than deleting.
  const stored = (await row('projects', 'project', project.id)) as Record<string, unknown> & { partitionKey: string; rowKey: string };
  const { etag: _etag, timestamp: _timestamp, ...rest } = stored;
  await putRow('projects', { ...rest, status: 'open', deletingSince: '2026-01-01T00:00:00.000Z' });
  expect((await cleanup(researcher, project.id)).status()).toBe(409);
  const restamped = await row('projects', 'project', project.id);
  expect(restamped?.status).toBe('closed');
  expect(restamped?.deletingSince).not.toBe('2026-01-01T00:00:00.000Z');
});

test('a cleanup that stopped after the project row went is finished by calling again', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const stranger = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  // What a cleanup leaves when it fails after deleting the project row: its tombstone, the owner
  // index entry, and a pledge row the final sweep did not reach.
  await deleteRow('projects', 'project', project.id);
  await putRow('claims', { partitionKey: `cleanup-${project.id}`, rowKey: 'tombstone', ownerId: researcher.id, createdAt: new Date().toISOString() });
  await putRow('pledges', { partitionKey: project.id, rowKey: 'latepledge0001', donorId: 'someone', amount: 1, status: 'cancelled' });
  expect((await cleanup(stranger, project.id)).status()).toBe(404);
  const res = await cleanup(researcher, project.id);
  expect(res.status(), await res.text()).toBe(200);
  expect(await rowsNaming(project.id)).toEqual([]);
  expect((await cleanup(researcher, project.id)).status()).toBe(404);
});

test('a project whose transfer is still in flight is not deleted', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  const now = new Date().toISOString();
  await putRow('pledges', {
    partitionKey: project.id, rowKey: 'zzzzinflight01', donorId: 'someone', donorName: 'x', amount: 10, method: 'api',
    status: 'pledged', inFlight: true, inFlightSince: now, createdAt: now, updatedAt: now,
  });
  expect((await closeThenDelete(researcher, project.id)).status()).toBe(409);
  expect(await row('projects', 'project', project.id)).not.toBeNull();
});

test('a slot taken moments ago whose pledge row is not written yet holds the deletion off', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  await putRow('claims', { partitionKey: project.id, rowKey: 'someone', pledgeId: 'notwrittenyet01', createdAt: new Date().toISOString() });
  expect((await closeThenDelete(researcher, project.id)).status()).toBe(409);
  // Once the slot is older than any request could still be running, it is an orphan and goes too.
  await putRow('claims', { partitionKey: project.id, rowKey: 'someone', pledgeId: 'notwrittenyet01', createdAt: '2026-01-01T00:00:00.000Z' });
  const res = await cleanup(researcher, project.id);
  expect(res.status(), await res.text()).toBe(200);
  expect(await row('claims', project.id, 'someone')).toBeNull();
  // The index entry went after the project row.
  expect(await row('projects', `owner-${researcher.id}`, project.id)).toBeNull();
});
