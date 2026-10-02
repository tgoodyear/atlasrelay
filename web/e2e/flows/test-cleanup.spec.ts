import { allRows, expect, postProject, putRow, row, test, type Person } from './fixtures';

// DELETE /api/test/projects/{id}: how the full-flow tests on dev remove the projects they post. The
// local stack turns it on the way Bicep does outside prod (E2E_PROJECT_CLEANUP=1). That the route
// does not exist without the setting is covered by the API's unit tests and scripts/check-params.sh.

const cleanup = (who: { request: Person['request'] }, id: string) => who.request.delete(`/api/test/projects/${id}`);

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

  const res = await cleanup(researcher, project.id);
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

test('a project whose transfer is still in flight is not deleted', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const project = await postProject(researcher);
  const now = new Date().toISOString();
  await putRow('pledges', {
    partitionKey: project.id, rowKey: 'zzzzinflight01', donorId: 'someone', donorName: 'x', amount: 10, method: 'api',
    status: 'pledged', inFlight: true, inFlightSince: now, createdAt: now, updatedAt: now,
  });
  expect((await cleanup(researcher, project.id)).status()).toBe(409);
  expect(await row('projects', 'project', project.id)).not.toBeNull();
});
