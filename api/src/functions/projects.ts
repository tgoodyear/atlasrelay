import { app, HttpRequest } from '@azure/functions';
import { getPrincipal, requirePrincipal } from '../lib/auth';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Project, createProject, ensureUser, getProject, getUser, listPledges, listProjects, now, patchProject, totals } from '../lib/store';
import { httpsUrl, int, isoDate, MAX_CREDITS, oneOf, str, tags } from '../lib/validate';
import { publicPledge, publicProject, publicUser } from '../lib/views';

/**
 * How many projects one listing will re-read pledges for. Anything above this keeps its cached
 * totals for that request; the write-back means a stale project needs correcting only once, so
 * the backlog drains across a few listings rather than being rescanned on every one.
 */
const STALE_REFRESH_LIMIT = 20;

app.http('projects-list', {
  route: 'projects',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const status = req.query.get('status') ?? 'open';
    const tag = req.query.get('tag') ?? '';
    const q = (req.query.get('q') ?? '').trim().toLowerCase();
    const sort = req.query.get('sort') ?? 'newest';

    // Read-time expiry has to reach the listing too, or an abandoned reservation shows as reserved
    // on every card for ever and the project keeps advertising a maxPledge of 0. Only a project
    // that currently shows reserved credits can be stale, and the cached total is rewritten on
    // every pledge write, so a cached pending of 0 is trustworthy.
    //
    // Two things keep that from turning an anonymous request into unbounded table work. The fan-out
    // is capped, so a large number of stale projects cannot be used to amplify one request. And a
    // correction is written back, so each stale project is re-read once and then drops out of the
    // fan-out for good, instead of being rescanned on every listing until somebody pledges to it.
    const rows = await listProjects();
    // Least recently touched first. Taking the newest N would starve the rest: a project with a
    // genuinely live reservation never leaves that prefix, so it would be rescanned on every
    // listing while an expired reservation on an older project was never looked at again. Any
    // write to a project refreshes updatedAt, including the correction below, so ordering by it
    // rotates through the candidates and the backlog actually drains.
    const stale = rows
      .filter((p) => p.creditsPending > 0)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
      .slice(0, STALE_REFRESH_LIMIT);
    const live = new Map<string, { confirmed: number; pending: number }>();
    await Promise.all(stale.map(async (p) => {
      const t = totals(await listPledges(p.id));
      live.set(p.id, t);
      // Write back either way. When the totals differ this corrects them; when they match it still
      // moves updatedAt, which is what lets the next listing look at a different set of projects
      // instead of the same prefix for ever.
      //
      // Conditional on the version this request selected. A pledge created or confirmed since the
      // read above has already recomputed these totals, and overwriting that with the older figure
      // would be worse than doing nothing: writing creditsPending back to 0 also drops the project
      // out of future refreshes, so the stale value would never be corrected. A 412 means somebody
      // else has just done this work, which is the outcome we wanted anyway. Best effort besides:
      // a listing must not fail because a correction could not be persisted.
      await patchProject(p.id, { creditsConfirmed: t.confirmed, creditsPending: t.pending }, p.etag)
        .catch(() => undefined);
    }));
    let projects = rows.map((p) => publicProject(p, live.get(p.id)));
    if (status === 'open') projects = projects.filter((p) => p.open);
    else if (status === 'funded') projects = projects.filter((p) => p.funded);
    else if (status === 'closed') projects = projects.filter((p) => p.status === 'closed');
    if (tag) projects = projects.filter((p) => (p.tags as string[]).includes(tag));
    if (q) projects = projects.filter((p) => `${p.title} ${p.summary} ${p.affiliation} ${p.ownerName}`.toLowerCase().includes(q));
    if (sort === 'need') projects.sort((a, b) => b.remaining - a.remaining);
    else if (sort === 'deadline') projects.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    else if (sort === 'progress') projects.sort((a, b) => b.creditsConfirmed / b.creditsRequested - a.creditsConfirmed / a.creditsRequested);

    return json({ projects }, 200, { 'cache-control': 'public, max-age=15' });
  }),
});

app.http('projects-get', {
  route: 'projects/{id}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'Not found');
    const [owner, pledges] = await Promise.all([getUser(project.ownerId), listPledges(id)]);
    const principal = getPrincipal(req);
    // The pledges are already loaded here, so use expiry-aware totals rather than the cached
    // counters: a lapsed reservation is released on reads too, not only after the next write.
    const live = totals(pledges);
    return json({
      project: publicProject(project, live),
      owner: owner ? publicUser(owner) : null,
      pledges: pledges.filter((p) => p.status !== 'cancelled').map(publicPledge),
      viewer: principal ? { isOwner: principal.userId === project.ownerId, userId: principal.userId } : null,
    });
  }),
});

function readProjectFields(body: Record<string, unknown>, required: boolean): Partial<Project> {
  const out: Partial<Project> = {};
  const title = str(body, 'title', { max: 120, required });
  if (title !== undefined) out.title = title;
  const summary = str(body, 'summary', { max: 280, required });
  if (summary !== undefined) out.summary = summary;
  const description = str(body, 'description', { max: 8000, required });
  if (description !== undefined) out.description = description;
  const creditsRequested = int(body, 'creditsRequested', { min: 1, max: MAX_CREDITS, required });
  if (creditsRequested !== undefined) out.creditsRequested = creditsRequested;
  const t = tags(body);
  if (t !== undefined) out.tags = t;
  const affiliation = str(body, 'affiliation', { max: 120 });
  if (affiliation !== undefined) out.affiliation = affiliation;
  for (const key of ['homepageUrl', 'repoUrl', 'paperUrl'] as const) {
    const v = httpsUrl(body, key);
    if (v !== undefined) out[key] = v;
  }
  const deadline = isoDate(body, 'deadline');
  if (deadline !== undefined) out.deadline = deadline;
  return out;
}

app.http('projects-create', {
  route: 'projects',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const user = await ensureUser(p.userId, p.identityProvider, p.userDetails);
    if (!user.atlasEmail) throw new HttpError(409, 'Add your RIPE NCC Access email to your profile before posting a project');
    const body = await readJson(req);
    const fields = readProjectFields(body, true);
    const ts = now();
    const project: Project = {
      id: newId(),
      ownerId: user.id,
      ownerName: user.displayName || user.handle,
      title: fields.title!,
      summary: fields.summary!,
      description: fields.description!,
      creditsRequested: fields.creditsRequested!,
      creditsConfirmed: 0,
      creditsPending: 0,
      status: 'open',
      tags: fields.tags ?? [],
      affiliation: fields.affiliation ?? user.affiliation ?? '',
      homepageUrl: fields.homepageUrl ?? '',
      repoUrl: fields.repoUrl ?? '',
      paperUrl: fields.paperUrl ?? '',
      deadline: fields.deadline ?? '',
      createdAt: ts,
      updatedAt: ts,
    };
    await createProject(project);

    // The owner may have deleted their profile while this request was in flight. Deletion closes
    // open projects, but it can only close the ones its sweep can see, so a project written after
    // that sweep would survive as an open project with nobody able to receive credits for it.
    // Checking after the write closes the gap from this side: either deletion sees this row and
    // closes it, or this sees the missing user row and closes itself. One always holds, because
    // both read after writing.
    if (!(await getUser(user.id))?.atlasEmail) {
      await patchProject(project.id, { status: 'closed' }).catch(() => undefined);
      throw new HttpError(409, 'Your profile is no longer available, so this project was not published.');
    }

    return json({ project: publicProject(project) }, 201);
  }),
});

app.http('projects-update', {
  route: 'projects/{id}',
  methods: ['PATCH'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'Not found');
    if (project.ownerId !== p.userId) throw new HttpError(403, 'Only the project owner can edit it');
    const body = await readJson(req);
    const fields = readProjectFields(body, false);
    const status = oneOf(body, 'status', ['open', 'closed'] as const);

    // Reopening needs the same precondition as posting. Deleting a profile closes its projects but
    // leaves them on the site, and signing in again recreates the profile with no RIPE address, so
    // without this an owner could reopen a project that lists publicly and fails every pledge,
    // because the handler would have no recipient to name.
    if (status === 'open' && project.status !== 'open') {
      const owner = await getUser(p.userId);
      if (!owner?.atlasEmail) {
        throw new HttpError(409, 'Add your RIPE NCC Access email to your profile before reopening a project; donors cannot send credits without it');
      }
    }

    // Merge rather than replace: this row was read at the top of the handler, and a pledge
    // recompute may have rewritten its credit totals since.
    const updated = await patchProject(id, { ...fields, ...(status ? { status } : {}) });

    // Same check as creation, for the same reason: the profile can be deleted between the guard
    // above and this write, and deletion's sweep may already have passed this row.
    if (updated.status === 'open' && !(await getUser(p.userId))?.atlasEmail) {
      const reclosed = await patchProject(id, { status: 'closed' });
      return json({ project: publicProject(reclosed) });
    }

    return json({ project: publicProject(updated) });
  }),
});
