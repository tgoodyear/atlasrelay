import { randomBytes } from 'node:crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { pledgeRow, postProjectInForm, postResults, saveProfile } from '../../web/e2e/ui';
import { ripeAccounts, ripeTransferCredits, type RipeSide } from '../accounts';
import { deleteBothProfiles, signedIn } from '../site';
import { pollUntil, ripeClient, shortSide, type RipeClient } from '../lib/ripe.mjs';

// Real RIPE Atlas transfers through the site, between two real RIPE Atlas accounts:
//
// - the donor account holds the credits; its key is the one the donor pastes into the pledge form;
// - the recipient account is the researcher's: its email goes on the researcher's profile, and its
//   key is used from here, never through the site, to check what arrived and to send it back.
//
// Each run nets to zero. The first test sends E2E_RIPE_TRANSFER_CREDITS (100 by default) from the
// donor account through the site, checks the recipient's balance rose by that much, then sends the
// same amount back from the recipient account with the RIPE Atlas API. The return runs in a
// finally block, so a test that fails after the credits moved still returns them. The second test
// pledges one credit more than the poorer key holds, and checks that the site refuses and that no
// transfer appears in either account's transaction log.
//
// Both keys need "Transfer credits to another user" and "Get information about your credits";
// beforeAll checks them and stops the file with a message naming the missing permission. Nothing
// here prints a key or an account email, and run.mjs redacts both from all output.

const ripe = ripeAccounts();
test.skip(!ripe, 'The job names no RIPE Atlas keys: run scripts/set-ripe-keys.sh, then scripts/provision.sh (docs/RUNBOOK.md)');

const run = process.env.E2E_RUN_ID?.slice(-12) || randomBytes(4).toString('hex');
const names = { researcher: `E2E researcher ${run}`, donor: `E2E donor ${run}` };
const fmt = (n: number) => n.toLocaleString('en-US');
/** Lines in the run's output: amounts and outcomes only. */
const note = (line: string) => console.log(`[ripe] ${line}`);

type Side = 'donor' | 'recipient';
const SECRET: Record<Side, string> = { donor: 'ripe-donor-key', recipient: 'ripe-recipient-key' };
let accounts: Record<Side, RipeSide>;
let api: Record<Side, RipeClient>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  accounts = ripe!;
  api = {
    donor: ripeClient(accounts.donor.key, { label: `the donor key (${SECRET.donor})` }),
    recipient: ripeClient(accounts.recipient.key, { label: `the recipient key (${SECRET.recipient})` }),
  };
  const missing: string[] = [];
  for (const side of ['donor', 'recipient'] as const) {
    if (!(await api[side].canRead())) missing.push(`${api[side].label} lacks "Get information about your credits"; the tests read balances and transaction logs with it`);
    if (!(await api[side].canTransfer())) missing.push(`${api[side].label} lacks "Transfer credits to another user"`);
  }
  // RIPE answers 403 for a key that is disabled, expired or unknown as well as for a missing permission.
  if (missing.length) throw new Error(`${missing.join('. ')}. Add the permission to the key at https://atlas.ripe.net/keys/, and check the key is enabled and inside its validity window.`);
  note('both keys can read their balance and transfer credits');
});

test.beforeEach(deleteBothProfiles);
test.afterEach(deleteBothProfiles);

/** On a project page, as the donor: open the pledge form and paste a key, as a person would. */
async function openApiPledge(page: Page, amount: number, key: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Send credits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send credits' });
  await expect(dialog.getByRole('radio', { name: /Transfer now with an API key/ })).toBeChecked();
  await dialog.getByLabel('Amount').fill(String(amount));
  await dialog.getByLabel('RIPE Atlas API key').fill(key);
  return dialog;
}

/** The researcher's profile names `account` as the place credits go, then a project asking for `credits`. */
async function postProjectFor(page: Page, account: string, credits: number, what: string): Promise<string> {
  await saveProfile(page, { displayName: names.researcher, atlasEmail: account });
  return postProjectInForm(page, {
    title: `E2E ${what} ${run}`,
    summary: `Automated real-transfer test run ${run}. Nothing is measured.`,
    description: `Posted by the Atlas Relay full-flow tests (run ${run}). The credits go back to the donor account when the test ends.`,
    creditsRequested: credits,
    tags: ['ping'],
  });
}

/**
 * Where a transfer submitted through the site stands, from the page: 'transferred' when the site
 * said RIPE accepted it, 'refused' when it said nothing was sent, 'unknown' from the click until
 * one of those appears (or for good, when neither does).
 */
type Outcome = 'not sent' | 'unknown' | 'transferred' | 'refused';

/**
 * Sends `amount` back from `from` to `to` when credits went `to` -> `from` through the site. Trusts
 * the site's 'transferred'; on 'unknown', sends only if `from`'s balance shows the credits arrived
 * and `alsoMoved`, when given, agrees. One transfer, never retried. Throws, unless the test already
 * failed, in which case it reports and leaves the test's own error to be the one shown.
 */
async function sendBack(o: {
  from: Side;
  to: Side;
  amount: number;
  fromBefore: number;
  outcome: Outcome;
  testFailed: boolean;
  alsoMoved?: () => Promise<boolean>;
}): Promise<void> {
  if (o.outcome === 'not sent' || o.outcome === 'refused') {
    note(`return: nothing to return (${o.outcome})`);
    return;
  }
  try {
    let now = await api[o.from].balance();
    if (o.outcome === 'unknown') {
      now = await pollUntil(() => api[o.from].balance(), (b) => b - o.fromBefore >= o.amount, { timeoutMs: 30_000 });
      if (now - o.fromBefore < o.amount || (o.alsoMoved && !(await o.alsoMoved()))) {
        note(`return: the balances show no transfer (the ${o.from} balance changed by ${now - o.fromBefore}), so nothing is returned`);
        return;
      }
    }
    await api[o.from].transfer(accounts[o.to].account, o.amount);
    const after = await pollUntil(() => api[o.from].balance(), (b) => now - b >= o.amount, { timeoutMs: 60_000 });
    if (now - after < o.amount) throw new Error(`RIPE accepted the return of ${o.amount} credits but the ${o.from} balance has not dropped yet`);
    note(`return: sent ${o.amount} credits from the ${o.from} account to the ${o.to} account; the ${o.from} balance is now ${after - o.fromBefore} from where the test started`);
  } catch (err) {
    const message = `RETURN FAILED: ${o.amount} credits may still be in the ${o.from} account. Check both transaction logs on atlas.ripe.net and send them back by hand if they are there. ${(err as Error).message}`;
    if (o.testFailed) console.error(`[ripe] ${message}`);
    else throw new Error(message);
  }
}

test('donor pastes a RIPE Atlas key, the credits reach the researcher, and the recipient sends them back', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const amount = ripeTransferCredits();
  const before = { donor: await api.donor.balance(), recipient: await api.recipient.balance() };
  expect(before.donor, `the donor account holds fewer than the ${amount} credits a run sends; seed it (docs/RUNBOOK.md)`).toBeGreaterThanOrEqual(amount);
  const researcher = await signedIn(browser, 'researcher');
  const donor = await signedIn(browser, 'donor');
  let outcome: Outcome = 'not sent';
  let failed = false;
  try {
    let projectPath = '';
    const resultsSummary = `Results of real-transfer test run ${run}.`;

    await test.step('researcher puts the recipient RIPE account on the profile and posts a project', async () => {
      projectPath = await postProjectFor(researcher.page, accounts.recipient.account, amount, 'real transfer');
    });

    await test.step('donor pastes the donor key, checks the balance, and transfers', async () => {
      const { page } = donor;
      await saveProfile(page, { displayName: names.donor, atlasEmail: '' });
      await page.goto(projectPath);
      const dialog = await openApiPledge(page, amount, accounts.donor.key);
      await dialog.getByRole('button', { name: 'Check balance' }).click();
      await expect(dialog.getByText(/^Balance: [\d,]+ credits$/)).toBeVisible();
      outcome = 'unknown';
      await dialog.getByRole('button', { name: `Transfer ${fmt(amount)} credits` }).click();
      const done = page.getByRole('dialog', { name: 'Credits transferred' });
      await expect(done.getByText(`RIPE Atlas accepted the transfer of ${fmt(amount)} credits. The pledge is confirmed.`)).toBeVisible({ timeout: 60_000 });
      outcome = 'transferred';
      note(`forward: the site reports ${amount} credits transferred`);
      await done.getByRole('button', { name: 'Done' }).click();
      await expect(pledgeRow(page, names.donor).getByText('Transferred via API')).toBeVisible();
    });

    await test.step('RIPE Atlas shows the credits in the recipient account', async () => {
      const now = await pollUntil(() => api.recipient.balance(), (b) => b - before.recipient >= amount, { timeoutMs: 60_000 });
      note(`forward: the recipient balance changed by ${now - before.recipient}`);
      expect(now - before.recipient, 'the recipient account did not receive the credits').toBeGreaterThanOrEqual(amount);
    });

    await test.step('researcher sees the pledge confirmed and posts results', async () => {
      const { page } = researcher;
      await page.goto(projectPath);
      // An API pledge is confirmed by the site when RIPE accepts it; the researcher has nothing to click.
      await expect(pledgeRow(page, names.donor).getByText('Transferred via API')).toBeVisible();
      await expect(page.locator('dl.kv')).toContainText(`Received${fmt(amount)}`);
      await expect(page.locator('.pill-green', { hasText: 'Funded' })).toBeVisible();
      const section = await postResults(page, { summary: resultsSummary, url: 'https://example.org/atlasrelay-e2e' });
      await expect(section.getByText(resultsSummary)).toBeVisible();
    });

    await test.step('a visitor sees the transfer and the results, and not the recipient email', async () => {
      const visitor = await browser.newContext({ baseURL: process.env.BASE_URL });
      const page = await visitor.newPage();
      await page.goto(projectPath);
      await expect(pledgeRow(page, names.donor).getByText('Transferred via API')).toBeVisible();
      await expect(page.getByText(resultsSummary)).toBeVisible();
      expect((await page.locator('body').innerText()).toLowerCase().includes(accounts.recipient.account.toLowerCase()), 'the page shows the recipient email').toBe(false);
      await visitor.close();
    });
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await researcher.context.close();
    await donor.context.close();
    await sendBack({ from: 'recipient', to: 'donor', amount, fromBefore: before.recipient, outcome, testFailed: failed });
  }
});

test('a pledge larger than the paying key\'s balance is refused and moves nothing', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const startedAt = Date.now();
  const before = { donor: await api.donor.balance(), recipient: await api.recipient.balance() };
  // The poorer key pays, so the amount (its balance plus one) is as small as it can be. The project
  // names the other account, so a transfer, if one went through, would not be to itself.
  const payer = shortSide(before);
  const payee: Side = payer === 'donor' ? 'recipient' : 'donor';
  const amount = before[payer] + 1;
  // Both keys can read their balance (beforeAll), so the site's own balance check is what refuses,
  // before any transfer is sent. A key without that permission would go on to the transfer and get
  // RIPE's refusal instead; the test cannot set that up, since it could not know such a key's balance.
  note(`short: the ${payer} key pays ${amount} credits, one more than its balance; the site's balance check should refuse`);
  const researcher = await signedIn(browser, 'researcher');
  const donor = await signedIn(browser, 'donor');
  let outcome: Outcome = 'not sent';
  let failed = false;
  try {
    let projectPath = '';
    await test.step(`researcher puts the ${payee} RIPE account on the profile and posts a project`, async () => {
      projectPath = await postProjectFor(researcher.page, accounts[payee].account, amount, 'short balance');
    });

    await test.step(`donor pastes the ${payer} key and asks to transfer more than it holds`, async () => {
      const { page } = donor;
      await saveProfile(page, { displayName: names.donor, atlasEmail: '' });
      await page.goto(projectPath);
      const dialog = await openApiPledge(page, amount, accounts[payer].key);
      await dialog.getByRole('button', { name: 'Check balance' }).click();
      await expect(dialog.getByText(/\(less than the amount\)/)).toBeVisible();
      outcome = 'unknown';
      await dialog.getByRole('button', { name: `Transfer ${fmt(amount)} credits` }).click();
      const error = dialog.locator('.alert-error');
      await expect(error).toHaveText(new RegExp(`^Your RIPE Atlas balance is [\\d,]+ credits, less than the ${fmt(amount)} you want to send$`), { timeout: 60_000 });
      outcome = 'refused';
      note('short: the site refused before sending');
      // Nothing moved, so the form stays open for the donor to correct, with the key cleared.
      await expect(dialog.getByRole('heading', { name: 'Send credits' })).toBeVisible();
      await expect(dialog.getByLabel('RIPE Atlas API key')).toHaveValue('');
    });

    await test.step('the site records nothing received and the pledge cancelled', async () => {
      const project = (await (await donor.context.request.get(`/api${projectPath}`)).json()).project;
      expect(project).toMatchObject({ creditsConfirmed: 0, creditsPending: 0 });
      const mine = (await (await donor.context.request.get(`/api${projectPath}/pledges`)).json()).pledges as { status: string }[];
      expect(mine.map((p) => p.status)).toEqual(['cancelled']);
    });

    await test.step('neither account shows a transfer, and the paying account kept its credits', async () => {
      // RIPE lists a transfer 40 to 70 seconds after it moves the credits; wait that out.
      await new Promise((r) => setTimeout(r, 90_000));
      for (const side of [payer, payee]) {
        const rows = await api[side].transfersSince(startedAt);
        const sign = side === payer ? -1 : 1;
        expect(rows.filter((t) => t.amount === sign * amount), `a transfer of ${amount} credits in the ${side} account's log`).toEqual([]);
      }
      const after = { donor: await api.donor.balance(), recipient: await api.recipient.balance() };
      note(`short: balances changed by donor ${after.donor - before.donor}, recipient ${after.recipient - before.recipient}`);
      expect(after[payer], `the ${payer} balance fell`).toBeGreaterThanOrEqual(before[payer]);
    });
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await researcher.context.close();
    await donor.context.close();
    // Only if the refusal never came: credits that went payer -> payee go back. The payee may earn
    // credits on its own, and the amount can be as small as 1, so its balance alone is not
    // evidence: the payer's must have fallen too.
    await sendBack({
      from: payee,
      to: payer,
      amount,
      fromBefore: before[payee],
      outcome,
      testFailed: failed,
      alsoMoved: async () => (await api[payer].balance()) < before[payer],
    });
  }
});
