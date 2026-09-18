import { app } from '@azure/functions';
import { handle, json } from '../lib/http';
import { siteStats } from '../lib/pledging';
import { listProjects } from '../lib/store';

app.http('stats', {
  route: 'stats',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async () => {
    const stats = siteStats(await listProjects());
    // These figures move only when someone posts a project or a pledge is confirmed, which is
    // rare, and they are decorative rather than load-bearing: nothing decides anything on them.
    // stale-while-revalidate lets a repeat visitor render instantly from cache while the refresh
    // happens behind them, so only the first view in five minutes waits on the function.
    return json({ stats }, 200, { 'cache-control': 'public, max-age=300, stale-while-revalidate=3600' });
  }),
});
