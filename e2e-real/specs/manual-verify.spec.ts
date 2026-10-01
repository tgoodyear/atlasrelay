import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { markSent, pledgeByHand, pledgeRow, postProjectInForm, saveProfile } from '../../web/e2e/ui';
import { ripeAccounts, ripeTransferCredits, type RipeSide } from '../accounts';
import { deleteBothProfiles, signedIn } from '../site';
import { pollUntil, ripeClient, RipeError, type RipeClient } from '../lib/ripe.mjs';

// A manual pledge checked against what really arrived, between the two real RIPE Atlas accounts
// ripe-transfer.spec.ts uses:
//
// - the donor pledges by hand on the site, then this file sends the credits with the donor key
//   straight to RIPE Atlas, as a person would on atlas.ripe.net;
// - the researcher confirms the pledge and pastes the recipient key into the optional field, and the
//   site reads the recipient account's transfers to find what arrived.
//
// The first test sends exactly what was pledged and expects "Verified with RIPE Atlas". The second
// sends less than was pledged and expects the site to offer the amount that arrived, then show it.
// Each test returns what it sent, recipient to donor, in an afterEach hook with the same rules as
// ripe-transfer.spec.ts, so a run nets to zero.
//
// Along the way it prints what the live API does that the site depends on and the local stub only
// imitates: whether page_size=100 is accepted, the incoming row's type, sign and text, how long the
// row takes to appear in the recipient's list, and whether both sides share a transaction id. No
// key or account email is printed, and run.mjs redacts both from all output.

const ripe = ripeAccounts();
test.skip(!ripe, 'The job names no RIPE Atlas keys: run scripts/set-ripe-keys.sh, then scripts/provision.sh (docs/RUNBOOK.md)');

const run = process.env.E2E_RUN_ID?.slice(-12) || randomBytes(4).toString('hex');
const names = { researcher: `E2E researcher ${run}`, donor: `E2E donor ${run}` };
const fmt = (n: number) => n.toLocaleString('en-US');
/** Lines in the run's output: amounts, outcomes and RIPE's behaviour only. */
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
    if (!(await api[side].canRead())) missing.push(`${api[side].label} lacks "Get information about your credits"`);
    if (!(await api[side].canTransfer())) missing.push(`${api[side].label} lacks "Transfer credits to another user"`);
  }
  if (missing.length) throw new Error(`${missing.join('. ')}. Add the permission to the key at https://atlas.ripe.net/keys/, and check the key is enabled and inside its validity window.`);
  // The query the site makes with the researcher's key. A refusal here would fail every check.
  const page = await api.recipient.adminPage();
  note(`live: GET /credits/transactions/?sort=-date&type=admin&page_size=100 answered HTTP ${page.status} with ${page.rows.length} rows (count ${page.count ?? 'absent'}, further page ${page.hasMore ? 'yes' : 'no'})`);
});

type Outcome = 'not sent' | 'unknown' | 'transferred' | 'refused';
type Return = { from: Side; to: Side; amount: number; fromBefore: number; outcome: Outcome; alsoMoved?: () => Promise<boolean> };

let pending: { contexts: BrowserContext[]; ret: Return } | null = null;

// The return, as in ripe-transfer.spec.ts: a hook, so a test that fails or times out after the
// credits moved still sends them back, with 3 minutes of its own, before the profiles are deleted.
test.afterEach(async ({}, testInfo) => {
  const p = pending;
  pending = null;
  if (!p) return;
  testInfo.setTimeout(3 * 60_000);
  for (const context of p.contexts) await context.close().catch(() => {});
  await sendBack({ ...p.ret, testFailed: testInfo.status !== testInfo.expectedStatus });
});

test.beforeEach(deleteBothProfiles);
test.afterEach(deleteBothProfiles);

/**
 * Sends `amount` back from `from` to `to`. The same rules as ripe-transfer.spec.ts: trusts
 * 'transferred'; on 'unknown', sends only if `from`'s balance shows the credits arrived and
 * `alsoMoved` agrees. One transfer, never retried.
 */
async function sendBack(o: Return & { testFailed: boolean }): Promise<void> {
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

/**
 * Sends `sent` credits donor -> recipient with the donor key, as the donor would on atlas.ripe.net,
 * and records the outcome on `ret` as it goes.
 */
async function sendByHand(ret: Return, sent: number): Promise<number> {
  ret.outcome = 'unknown';
  const at = Date.now();
  try {
    await api.donor.transfer(accounts.recipient.account, sent);
  } catch (err) {
    if (err instanceof RipeError && err.status >= 400 && err.status < 500) ret.outcome = 'refused';
    throw err;
  }
  ret.outcome = 'transferred';
  note(`forward: RIPE accepted ${sent} credits from the donor account to the recipient account`);
  return at;
}

/**
 * Waits (up to 4 minutes) for the transfer to be listed on both sides, and prints what the rows
 * look like. Returns the recipient row's transaction id.
 */
async function observeRows(sentAt: number, sent: number): Promise<string> {
  const earliest = Math.floor(sentAt / 1000) * 1000;
  const incoming = async () => (await api.recipient.adminPage()).rows.find((r) => r.amount === sent && r.date >= earliest);
  const row = await pollUntil(incoming, (r) => Boolean(r), { timeoutMs: 4 * 60_000, intervalMs: 5_000 });
  const seconds = Math.round((Date.now() - sentAt) / 1000);
  expect(row, `no incoming row of ${sent} credits in the recipient's list within 4 minutes`).toBeTruthy();
  note(`live: the incoming row was listed within ${seconds} s of the transfer; type ${row!.type}, amount ${row!.amount > 0 ? 'positive' : 'not positive'} (${row!.amount}), RIPE time ${Math.round((row!.date - sentAt) / 1000)} s after the request was sent, text "${row!.note || '(empty)'}"`);
  const outgoing = (await api.donor.adminPage()).rows.find((r) => r.amount === -sent && r.date >= earliest);
  if (outgoing) {
    note(`live: the donor's row is type ${outgoing.type}, amount ${outgoing.amount}, text "${outgoing.note || '(empty)'}"; transaction ids ${outgoing.id === row!.id ? 'match' : 'differ'} between the two sides`);
  } else {
    note('live: the donor-side row was not listed yet, so the ids could not be compared');
  }
  return row!.id;
}

/** The researcher posts a project naming the recipient account; the donor pledges `pledged` by hand and marks it sent. */
async function pledgeByHandFor(researcher: Page, donor: Page, pledged: number, what: string): Promise<string> {
  await saveProfile(researcher, { displayName: names.researcher, atlasEmail: accounts.recipient.account });
  const projectPath = await postProjectInForm(researcher, {
    title: `E2E ${what} ${run}`,
    summary: `Automated manual-pledge check, run ${run}. Nothing is measured.`,
    description: `Posted by the Atlas Relay full-flow tests (run ${run}). The credits go back to the donor account when the test ends.`,
    creditsRequested: pledged,
    tags: ['ping'],
  });
  await saveProfile(donor, { displayName: names.donor, atlasEmail: '' });
  await donor.goto(projectPath);
  const done = await pledgeByHand(donor, { amount: pledged });
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(pledgeRow(donor, names.donor).getByText('Pledged', { exact: true })).toBeVisible();
  return projectPath;
}

/**
 * As the researcher: open the confirm dialog, paste the recipient key, and check. While RIPE has not
 * listed the row yet the dialog says so; this presses Check again, for up to 3 minutes.
 */
async function checkWithRecipientKey(page: Page): Promise<Locator> {
  await pledgeRow(page, names.donor).getByRole('button', { name: 'Confirm received' }).click();
  const dialog = page.getByRole('dialog', { name: /Confirm this pledge|Pledge confirmed/ });
  await dialog.getByLabel('RIPE Atlas API key (optional)').fill(accounts.recipient.key);
  // Each click is one PATCH; waiting for its answer, then for the dialog to settle, means the alert
  // read next is this answer's and not the previous one's.
  const answered = () => page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/pledges/'), { timeout: 60_000 });
  await Promise.all([answered(), dialog.getByRole('button', { name: 'Check and confirm' }).click()]);
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    await expect(dialog.getByRole('button', { name: /Confirming…|Checking…/ })).toHaveCount(0);
    const answer = dialog.locator('.alert-success, .alert-warn, .alert-error').first();
    await expect(answer).toBeVisible({ timeout: 30_000 });
    const text = await answer.innerText();
    if (!/can take a minute or two to appear|did not answer/.test(text) || Date.now() > deadline) return dialog;
    note(`check: the site answered "${text.split('.')[0]}", checking again`);
    await page.waitForTimeout(15_000);
    await Promise.all([answered(), dialog.getByRole('button', { name: 'Check again' }).click()]);
  }
}

test('a manual pledge of the amount sent is verified with RIPE Atlas', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const amount = ripeTransferCredits();
  const before = { donor: await api.donor.balance(), recipient: await api.recipient.balance() };
  expect(before.donor, `the donor account holds fewer than the ${amount} credits a run sends; seed it (docs/RUNBOOK.md)`).toBeGreaterThanOrEqual(amount);
  const researcher = await signedIn(browser, 'researcher');
  const donor = await signedIn(browser, 'donor');
  const ret: Return = { from: 'recipient', to: 'donor', amount, fromBefore: before.recipient, outcome: 'not sent', alsoMoved: async () => (await api.donor.balance()) < before.donor };
  pending = { contexts: [researcher.context, donor.context], ret };
  let projectPath = '';
  let transactionId = '';

  await test.step('researcher posts a project, donor pledges by hand', async () => {
    projectPath = await pledgeByHandFor(researcher.page, donor.page, amount, 'manual check');
  });

  await test.step('donor sends exactly the pledged amount on RIPE Atlas and marks it sent', async () => {
    const sentAt = await sendByHand(ret, amount);
    await markSent(donor.page, names.donor);
    transactionId = await observeRows(sentAt, amount);
  });

  await test.step('researcher confirms with the recipient key and the pledge is verified', async () => {
    const { page } = researcher;
    await page.goto(projectPath);
    const dialog = await checkWithRecipientKey(page);
    const several = dialog.getByRole('radio', { name: new RegExp(`transaction ${transactionId}`) });
    if (await several.count()) {
      // Another pledge of the same amount on this account, from an earlier run, could account for the
      // row, so the site asks rather than matching it. The researcher knows which one is theirs.
      note(`check: the site listed the arrival for the researcher to choose: "${(await dialog.locator('.alert-warn').innerText()).split('.')[0]}"`);
      await several.check();
      await dialog.getByRole('button', { name: `Record ${fmt(amount)} credits` }).click();
    }
    await expect(dialog.locator('.alert-success')).toHaveText(`RIPE Atlas shows ${fmt(amount)} credits arrived, and the pledge now records that amount. RIPE transaction ${transactionId}.`);
    note('check: verified, with the recipient row as the reference');
    await dialog.getByRole('button', { name: 'Done' }).click();
    const row = pledgeRow(page, names.donor);
    await expect(row.getByText('Confirmed', { exact: true })).toBeVisible();
    await expect(row.getByText('Verified with RIPE Atlas')).toBeVisible();
    await expect(page.locator('dl.kv')).toContainText(`Received${fmt(amount)}`);
  });

  await test.step('a visitor sees the verified pledge, and not the recipient email', async () => {
    const visitor = await browser.newContext({ baseURL: process.env.BASE_URL });
    const page = await visitor.newPage();
    await page.goto(projectPath);
    await expect(pledgeRow(page, names.donor).getByText('Verified with RIPE Atlas')).toBeVisible();
    expect((await page.locator('body').innerText()).toLowerCase().includes(accounts.recipient.account.toLowerCase()), 'the page shows the recipient email').toBe(false);
    await visitor.close();
  });
});

test('a manual pledge of more than was sent records what arrived', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const pledged = ripeTransferCredits();
  test.skip(pledged < 2, 'needs at least 2 credits to send less than was pledged');
  const sent = pledged - Math.max(1, Math.round(pledged / 10));
  const before = { donor: await api.donor.balance(), recipient: await api.recipient.balance() };
  expect(before.donor, `the donor account holds fewer than the ${sent} credits this test sends`).toBeGreaterThanOrEqual(sent);
  const researcher = await signedIn(browser, 'researcher');
  const donor = await signedIn(browser, 'donor');
  const ret: Return = { from: 'recipient', to: 'donor', amount: sent, fromBefore: before.recipient, outcome: 'not sent', alsoMoved: async () => (await api.donor.balance()) < before.donor };
  pending = { contexts: [researcher.context, donor.context], ret };
  let projectPath = '';
  let transactionId = '';

  await test.step(`researcher posts a project, donor pledges ${pledged} by hand`, async () => {
    projectPath = await pledgeByHandFor(researcher.page, donor.page, pledged, 'short manual check');
  });

  await test.step(`donor sends ${sent} on RIPE Atlas and marks it sent`, async () => {
    const sentAt = await sendByHand(ret, sent);
    await markSent(donor.page, names.donor);
    transactionId = await observeRows(sentAt, sent);
  });

  await test.step('researcher checks, is shown what arrived, and records it', async () => {
    const { page } = researcher;
    await page.goto(projectPath);
    const dialog = await checkWithRecipientKey(page);
    const warn = dialog.locator('.alert-warn');
    const text = await warn.innerText();
    // The usual answer. A row an earlier run's pledge of the same amount could account for is listed
    // for choosing instead, with nothing selected.
    if (!text.startsWith(`RIPE Atlas shows ${fmt(sent)} credits arrived since this pledge was made (pledged ${fmt(pledged)}).`)) {
      note(`check: the site answered "${text.split('.')[0]}"`);
    } else {
      note(`check: the site offered ${sent} credits arrived (pledged ${pledged})`);
    }
    const choice = dialog.getByRole('radio', { name: new RegExp(`transaction ${transactionId}`) });
    await choice.check();
    await dialog.getByRole('button', { name: `Record ${fmt(sent)} credits` }).click();
    await expect(dialog.locator('.alert-success')).toHaveText(`RIPE Atlas shows ${fmt(sent)} credits arrived (pledged ${fmt(pledged)}), and the pledge now records that amount. RIPE transaction ${transactionId}.`);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('dl.kv')).toContainText(`Received${fmt(sent)}`);
  });

  await test.step(`a visitor sees ${sent} credits (pledged ${pledged}), verified`, async () => {
    const visitor = await browser.newContext({ baseURL: process.env.BASE_URL });
    const page = await visitor.newPage();
    await page.goto(projectPath);
    const row = pledgeRow(page, names.donor);
    await expect(row).toContainText(`${fmt(sent)} credits (pledged ${fmt(pledged)})`);
    await expect(row.getByText('Verified with RIPE Atlas')).toBeVisible();
    await visitor.close();
  });
});
