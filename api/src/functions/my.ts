import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json } from '../lib/http';
import { getProject, listPledgesByDonor, listProjectsByOwner } from '../lib/store';
import { privatePledge, publicProject } from '../lib/views';

app.http('my', {
  route: 'my',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const [projects, pledges] = await Promise.all([listProjectsByOwner(p.userId), listPledgesByDonor(p.userId)]);
    const projectIds = [...new Set(pledges.map((x) => x.projectId))];
    const titles = new Map<string, string>();
    await Promise.all(
      projectIds.map(async (id) => {
        const proj = await getProject(id);
        if (proj) titles.set(id, proj.title);
      }),
    );
    return json({
      projects: projects.map((p) => publicProject(p)),
      pledges: pledges.map((x) => ({ ...privatePledge(x), projectTitle: titles.get(x.projectId) ?? '' })),
    });
  }),
});
