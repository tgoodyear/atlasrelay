import { app, HttpRequest } from '@azure/functions';
import { requireAccount } from '../lib/account';
import { assertKeyFormat, getCredits } from '../lib/atlas';
import { handle, json, readJson } from '../lib/http';

/** Let a signed-in donor preview the balance behind a key before sending. Nothing is stored. */
app.http('atlas-balance', {
  route: 'atlas/balance',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    await requireAccount(req);
    const body = await readJson(req);
    const key = assertKeyFormat(body.apiKey);
    const credits = await getCredits(key);
    return json({
      balance: credits.current_balance,
      estimatedDailyIncome: credits.estimated_daily_income ?? null,
      estimatedDailyExpenditure: credits.estimated_daily_expenditure ?? null,
    });
  }),
});
