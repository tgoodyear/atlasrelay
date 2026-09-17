import { app, HttpRequest } from '@azure/functions';
import { getPrincipal, requirePrincipal } from '../lib/auth';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { createProject, ensureUser, getProject, getUser, listPledges, listProjects, now, Project, saveProject } from '../lib/store';
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

    let projects = (await listProjects()).map(publicProject);
    if (status === 'open') projects = projects.filter((p) => p.status === 'open' && p.capacity > 0);
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
    return json({
      project: publicProject(project),
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
    const updated = await saveProject({ ...project, ...fields, ...(status ? { status } : {}) });
    return json({ project: publicProject(updated) });
  }),
});
