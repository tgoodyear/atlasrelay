import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json } from '../lib/http';
import { Project, getProject, listPledges, listPledgesByDonor, listProjectsByOwner, now, patchProject, totals } from '../lib/store';
import { privatePledge, publicProject } from '../lib/views';

/** Projects one dashboard request will re-read pledges for. See the same cap on the listing. */
const DASHBOARD_REFRESH_LIMIT = 20;

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
    // Bounded the same way the public listing is, and for the same reason: one scan per project
    // with a reservation is unbounded work an account can grow at will. Least recently checked
    // first, so the rotation drains rather than pinning the same prefix. Anything beyond the cap
    // keeps its cached totals for this request and is picked up on the next one.
    const checked = (x: Project): string => x.totalsCheckedAt ?? '';
    const stale = projects
      .filter((x) => x.creditsPending > 0 || x.totalsDirty)
      .sort((a, b) => (checked(a) < checked(b) ? -1 : checked(a) > checked(b) ? 1 : 0))
      .slice(0, DASHBOARD_REFRESH_LIMIT);
    const live = new Map<string, { confirmed: number; pending: number }>();
    await Promise.all(
      stale.map(async (x) => {
        // Independent, for the same reason as the public listing: this refresh is optional
        // maintenance, and one failing scan must not take the owner's whole dashboard down.
        let t: { confirmed: number; pending: number };
        try {
          t = totals(await listPledges(x.id));
        } catch (err) {
          console.error(`Could not refresh totals for project ${x.id}:`, err instanceof Error ? err.message : err);
          return;
        }
        live.set(x.id, t);
        await patchProject(
          x.id,
          { creditsConfirmed: t.confirmed, creditsPending: t.pending, totalsCheckedAt: now(), totalsDirty: false, updatedAt: x.updatedAt },
          x.etag,
        ).catch(() => undefined);
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
