import { app } from '@azure/functions';
import { handle, json } from '../lib/http';
import { capacity, remainingToGoal } from '../lib/pledging';
import { listProjects } from '../lib/store';

app.http('stats', {
  route: 'stats',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async () => {
    const projects = await listProjects();
    // "Open" means the same thing as in the project listing: status open with capacity left.
    const open = projects.filter((p) => p.status === 'open' && capacity(p.creditsRequested, p.creditsConfirmed, p.creditsPending) > 0);
    const stats = {
      projects: projects.length,
      openProjects: open.length,
      creditsRequested: open.reduce((s, p) => s + remainingToGoal(p.creditsRequested, p.creditsConfirmed), 0),
      creditsTransferred: projects.reduce((s, p) => s + p.creditsConfirmed, 0),
      fundedProjects: projects.filter((p) => p.creditsConfirmed >= p.creditsRequested).length,
    };
    return json({ stats }, 200, { 'cache-control': 'public, max-age=60' });
  }),
});
