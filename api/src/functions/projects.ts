import { app, HttpRequest } from '@azure/functions';
import { getPrincipal, requirePrincipal } from '../lib/auth';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { createProject, ensureUser, getProject, getUser, listPledges, listProjects, listProjectsByOwner, now, Project, saveProject, totals } from '../lib/store';
import { MAX_OPEN_PROJECTS_PER_USER } from '../lib/pledging';
import { httpsUrl, int, isoDate, MAX_CREDITS, oneOf, str, tags } from '../lib/validate';
import { publicPledge, publicProject, publicUser } from '../lib/views';

app.http('projects-list', {
  route: 'projects',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const status = req.query.get('status') ?? 'open';
    const tag = req.query.get('tag') ?? '';
    const q = (req.query.get('q') ?? '').trim().toLowerCase();
    const sort = req.query.get('sort') ?? 'newest';

    // Expiry is a read-time rule, so the list has to apply it as well. Without this an abandoned
    // pledge keeps showing as reserved on every card for ever, and the project keeps advertising a
    // maxPledge of 0, until some unrelated write happens to recompute that row.
    // Only a project that currently shows reserved credits can be holding a stale reservation, and
    // the cached total is rewritten on every pledge write, so a cached pending of 0 is trustworthy.
    // That keeps this to a handful of partition reads rather than one per project.
    const rows = await listProjects();
    const live = await Promise.all(rows.map(async (p) =>
      (p.creditsPending > 0 ? totals(await listPledges(p.id)) : undefined)));
    let projects = rows.map((p, i) => publicProject(p, live[i]));
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

    // Posting is free, and every project hands its owner's contact address to anyone who starts
    // a pledge, so one account cannot keep an unbounded number of them open at once.
    const open = (await listProjectsByOwner(user.id)).filter((x) => x.status === 'open').length;
    if (open >= MAX_OPEN_PROJECTS_PER_USER) {
      throw new HttpError(409, `You already have ${MAX_OPEN_PROJECTS_PER_USER} open projects. Close one before posting another.`);
    }

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
      moderationClosed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await createProject(project);

    // The check above reads before writing, so simultaneous requests can all pass it. Settle it
    // now the row is visible: re-read, and if this owner is over the cap, the newest projects
    // close themselves back down to it. Ids are time-prefixed, so the newest row always sees every
    // older one and every racer reaches the same verdict without coordination. Unlike a transfer,
    // nothing irreversible has happened, so closing is a complete remedy.
    const mine = (await listProjectsByOwner(user.id)).filter((x) => x.status === 'open');
    if (mine.length > MAX_OPEN_PROJECTS_PER_USER) {
      // Close every surplus row, not just this request's own. A request that only withdrew itself
      // would leave the cap broken whenever the row it should have closed belongs to a rival that
      // has already returned: the newest rows are the surplus, and the request holding an older id
      // is the one that sees them all. Ids are time-prefixed, so every racer that gets here picks
      // the same surplus set, and closing twice is harmless.
      const surplus = mine.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(MAX_OPEN_PROJECTS_PER_USER);
      for (const extra of surplus) {
        await saveProject({ ...extra, status: 'closed' });
      }
      if (surplus.some((x) => x.id === project.id)) {
        throw new HttpError(409, `You already have ${MAX_OPEN_PROJECTS_PER_USER} open projects. Close one before posting another.`);
      }
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

    // Reopening is another way to end up with more open projects than the cap allows: close one,
    // post a replacement, then reopen the first. The limit has to hold on this path too.
    if (status === 'open' && project.status !== 'open') {
      // A takedown has to survive the owner. Without this, closing a reported project is undone by
      // its owner from any stale edit form, and the remedy in SECURITY.md is not a remedy at all.
      if (project.moderationClosed) {
        throw new HttpError(403, 'This project was closed by the site and cannot be reopened. Contact the maintainer if you think that was a mistake.');
      }
      const open = (await listProjectsByOwner(p.userId)).filter((x) => x.status === 'open').length;
      if (open >= MAX_OPEN_PROJECTS_PER_USER) {
        throw new HttpError(409, `You already have ${MAX_OPEN_PROJECTS_PER_USER} open projects. Close one before reopening this.`);
      }
    }

    const updated = await saveProject({ ...project, ...fields, ...(status ? { status } : {}) });
    return json({ project: publicProject(updated) });
  }),
});
