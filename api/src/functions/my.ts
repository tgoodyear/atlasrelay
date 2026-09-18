import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json } from '../lib/http';
import { getProject, listPledges, listPledgesByDonor, listProjectsByOwner, totals } from '../lib/store';
import { privatePledge, publicProject } from '../lib/views';

app.http('my', {
  route: 'my',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const [projects, pledges] = await Promise.all([listProjectsByOwner(p.userId), listPledgesByDonor(p.userId)]);

    // Expiry is a read-time rule, so the owner's own dashboard has to apply it as well. Without
    // this an abandoned reservation sits here as "awaiting your confirmation" for ever, which is
    // the one place it would actively mislead: this is where an owner decides whether a pledge
    // still needs chasing. Only projects showing a reservation can be stale, and the cached total
    // is rewritten on every pledge write, so a cached pending of 0 is trustworthy.
    const live = new Map<string, { confirmed: number; pending: number }>();
    await Promise.all(
      projects
        .filter((x) => x.creditsPending > 0)
        .map(async (x) => {
          live.set(x.id, totals(await listPledges(x.id)));
        }),
    );
    const projectIds = [...new Set(pledges.map((x) => x.projectId))];
    const titles = new Map<string, string>();
    await Promise.all(
      projectIds.map(async (id) => {
        const proj = await getProject(id);
        if (proj) titles.set(id, proj.title);
      }),
    );
    return json({
      projects: projects.map((x) => publicProject(x, live.get(x.id))),
      pledges: pledges.map((x) => ({ ...privatePledge(x), projectTitle: titles.get(x.projectId) ?? '' })),
    });
  }),
});
