import { app } from '@azure/functions';
import { handle, json } from '../lib/http';
import { listProjects } from '../lib/store';

app.http('stats', {
  route: 'stats',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async () => {
    const projects = await listProjects();
    const open = projects.filter((p) => p.status === 'open' && p.creditsConfirmed < p.creditsRequested);
    const stats = {
      projects: projects.length,
      openProjects: open.length,
      creditsRequested: open.reduce((s, p) => s + Math.max(0, p.creditsRequested - p.creditsConfirmed), 0),
      creditsTransferred: projects.reduce((s, p) => s + p.creditsConfirmed, 0),
      fundedProjects: projects.filter((p) => p.creditsConfirmed >= p.creditsRequested).length,
    };
    return json({ stats }, 200, { 'cache-control': 'public, max-age=60' });
  }),
});
