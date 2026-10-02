import { app } from '@azure/functions';
import { invocationLog } from './lib/telemetry';
import './functions/me';
import './functions/projects';
import './functions/pledges';
import './functions/my';
import './functions/stats';
import './functions/atlas';
import './functions/sitemap';
import './functions/projectPage';
import './functions/testCleanup';

app.setup({ enableHttpStream: false });

// Run every handler with its InvocationContext available to lib/telemetry.ts, so log lines written
// deep inside the libraries go to the invocation's logger: they reach Application Insights under
// the function's category and carry the request's operation id.
app.hook.preInvocation((hook) => {
  const handler = hook.functionHandler;
  const context = hook.invocationContext;
  hook.functionHandler = (input, ctx) => invocationLog.run(context, () => handler(input, ctx));
});
