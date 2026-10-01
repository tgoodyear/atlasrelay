import type { Page } from '@playwright/test';
import {
  FAKE_KEY_PREFIX,
  allRows,
  expect,
  fakeKey,
  postProject,
  recordResponses,
  ripe,
  row,
  stackLog,
  test,
  type CreatedProject,
  type Person,
} from './fixtures';
import { adminRow, transactionsOk, transactionsRefused, type Scenario } from './harness/ripe-stub';

// The researcher confirms a manual pledge with a key of their own, and the API reads their RIPE
// Atlas transaction list (the stub in harness/ripe-stub.ts) to record what actually arrived.

async function manualPledge(person: (o: { role: string }) => Promise<Person>, amount = 700, requested = 1000) {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: requested });
  const res = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount, method: 'manual' } });
  expect(res.status(), await res.text()).toBe(201);
  const pledgeId = (await res.json()).pledge.id as string;
  const sent = await donor.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'sent' } });
  expect(sent.status()).toBe(200);
  return { researcher, donor, project, pledgeId };
}

/** Open the confirm dialog for the donor's pledge and submit it with the key. */
async function checkWithKey(page: Page, project: CreatedProject, donor: Person, key: string) {
  await page.goto(`/projects/${project.id}`);
  await page.locator('.pledge').filter({ hasText: donor.name }).getByRole('button', { name: 'Confirm received' }).click();
  const dialog = page.getByRole('dialog', { name: /Confirm this pledge|Pledge confirmed/ });
  await dialog.getByLabel('RIPE Atlas API key (optional)').fill(key);
  await dialog.getByRole('button', { name: 'Check and confirm' }).click();
  return dialog;
}

async function ownerKey(scenario: Scenario): Promise<string> {
  const key = fakeKey();
  await ripe.scenario(key, scenario);
  return key;
}

test('an exact arrival is confirmed as verified, and the key is kept nowhere', async ({ person, signedOut }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  // The arrival, a transfer the researcher made themselves, and someone else's earlier transfer.
  const key = await ownerKey({ transactions: transactionsOk([adminRow(910001, 700, 5), adminRow(910002, -700, 6), adminRow(910003, 700, -3600)]) });
  const responses = recordResponses(researcher.page);

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-success')).toHaveText('RIPE Atlas shows 700 credits arrived, and the pledge now records that amount. RIPE transaction 910001.');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const pledge = researcher.page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(pledge.getByText('Verified with RIPE Atlas')).toBeVisible();
  await expect(researcher.page.locator('dl.kv')).toContainText('Received700');

  // The public sees the marker too.
  const visitor = await signedOut();
  await visitor.page.goto(`/projects/${project.id}`);
  await expect(visitor.page.locator('.pledge').filter({ hasText: donor.name }).getByText('Verified with RIPE Atlas')).toBeVisible();

  // One read of the transaction list with the owner's key, and nothing else with it.
  const seen = await ripe.requests(key);
  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe('GET');
  expect(seen[0].path).toBe('/api/v2/credits/transactions/?sort=-date&type=admin&page_size=100');

  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'confirmed', amount: 700, receivedAmount: 700, amountVerified: true, transactionId: '910001' });

  for (const body of await responses()) expect(body, body.split('\n')[0]).not.toContain(key);
  const stored = JSON.stringify(await allRows());
  expect(stored).not.toContain(FAKE_KEY_PREFIX);
  await expect.poll(() => stackLog('func').includes(`"outcome":"exact","projectId":"${project.id}"`), { timeout: 10_000 }).toBe(true);
  expect(stackLog('func')).not.toContain(FAKE_KEY_PREFIX);
  expect(stackLog('swa')).not.toContain(FAKE_KEY_PREFIX);
  expect(stackLog('azurite')).not.toContain(FAKE_KEY_PREFIX);
});

test('a different amount is shown, and recording it changes the totals', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: transactionsOk([adminRow(920001, 500, 5)]) });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-warn')).toHaveText('RIPE Atlas shows 500 credits arrived since this pledge was made (pledged 700).');
  // Nothing is recorded until the researcher chooses.
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'sent' });
  await expect(dialog.getByRole('radio', { name: /500 credits/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Record 500 credits' }).click();
  await expect(dialog.locator('.alert-success')).toHaveText('RIPE Atlas shows 500 credits arrived (pledged 700), and the pledge now records that amount. RIPE transaction 920001.');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const pledge = researcher.page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge).toContainText('500 credits (pledged 700)');
  await expect(pledge.getByText('Verified with RIPE Atlas')).toBeVisible();
  await expect(researcher.page.locator('dl.kv')).toContainText('Received500');
  await expect(researcher.page.locator('dl.kv')).toContainText('Pending0');
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ amount: 700, receivedAmount: 500, amountVerified: true });

  // The donor sees the same on their dashboard.
  await donor.page.goto('/dashboard');
  await donor.page.getByRole('tab', { name: /My pledges/ }).click();
  const dashRow = donor.page.getByRole('row').filter({ hasText: project.title });
  await expect(dashRow).toContainText('500 (pledged 700)');
  await expect(dashRow).toContainText('verified with RIPE Atlas');
  expect(await ripe.transactionReads(key)).toHaveLength(2);
});

test('nothing arrived yet: the researcher can confirm the pledged amount without the check', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: transactionsOk([adminRow(930001, -50, 5)]) });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-warn')).toContainText('can take a minute or two to appear');
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(async () => (await ripe.transactionReads(key)).length).toBe(2);
  await expect(dialog.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(dialog.locator('.alert-warn')).toContainText('can take a minute or two to appear');
  await dialog.getByRole('button', { name: 'Confirm the pledged 700 credits without checking' }).click();
  await expect(dialog).toHaveCount(0);

  const pledge = researcher.page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(pledge.getByText('Verified with RIPE Atlas')).toHaveCount(0);
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'confirmed', receivedAmount: 0, amountVerified: false, transactionId: '' });
  // The fallback sends no key, so RIPE is not asked again.
  expect(await ripe.transactionReads(key)).toHaveLength(2);
});

test('several candidates are listed and the researcher picks one', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: transactionsOk([adminRow(940001, 700, 5, 'first'), adminRow(940002, 700, 9, 'second')]) });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-warn')).toContainText('more than one incoming transfer');
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Choose a transfer' })).toBeDisabled();
  await dialog.getByRole('radio', { name: /first/ }).check();
  await dialog.getByRole('button', { name: 'Record 700 credits' }).click();
  await expect(dialog.locator('.alert-success')).toContainText('RIPE transaction 940001.');
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ transactionId: '940001', amountVerified: true });
});

test('one arrival is never matched to two pledges', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const first = await person({ role: 'donor' });
  const second = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 1000 });
  const ids: string[] = [];
  for (const donor of [first, second]) {
    const res = await donor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 300, method: 'manual' } });
    expect(res.status()).toBe(201);
    ids.push((await res.json()).pledge.id);
  }
  const key = await ownerKey({ transactions: transactionsOk([adminRow(950001, 300, 5)]) });

  // Both donors pledged 300 and either could have sent it, so it is not matched for the owner.
  const asked = await researcher.request.patch(`/api/pledges/${project.id}/${ids[0]}`, { data: { status: 'confirmed', apiKey: key } });
  expect(asked.status()).toBe(409);
  const asking = (await asked.json()).error.details.verification;
  expect(asking.outcome).toBe('several');
  expect(asking.receipts).toMatchObject([{ id: '950001', amount: 300, contested: true }]);

  // The owner chooses it for the first pledge.
  const ok = await researcher.request.patch(`/api/pledges/${project.id}/${ids[0]}`, { data: { status: 'confirmed', apiKey: key, transactionId: '950001' } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).verification).toMatchObject({ outcome: 'chosen', received: 300, transactionId: '950001' });

  const again = await researcher.request.patch(`/api/pledges/${project.id}/${ids[1]}`, { data: { status: 'confirmed', apiKey: key } });
  expect(again.status()).toBe(409);
  expect((await again.json()).error.details.verification.outcome).toBe('none');
  // Nor by naming it.
  const named = await researcher.request.patch(`/api/pledges/${project.id}/${ids[1]}`, { data: { status: 'confirmed', apiKey: key, transactionId: '950001' } });
  expect(named.status()).toBe(409);
  expect((await named.json()).error.details.verification.outcome).toBe('choice-unavailable');
  expect(await row('pledges', project.id, ids[1])).toMatchObject({ status: 'pledged' });
});

test('an API transfer that arrived after a manual pledge is not matched to it', async ({ person }) => {
  const researcher = await person({ role: 'researcher' });
  const manualDonor = await person({ role: 'donor' });
  const apiDonor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: 2000 });
  const manual = await manualDonor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 700, method: 'manual' } });
  expect(manual.status()).toBe(201);
  const manualId = (await manual.json()).pledge.id as string;

  // A second donor sends the same amount through the API, which the server confirms with no reference.
  const donorKey = fakeKey();
  await ripe.scenario(donorKey, {});
  const api = await apiDonor.request.post(`/api/projects/${project.id}/pledges`, { data: { amount: 700, method: 'api', apiKey: donorKey } });
  expect(api.status(), await api.text()).toBe(201);
  expect((await api.json()).pledge.status).toBe('confirmed');

  // The only arrival in the researcher's log is that API transfer.
  const key = await ownerKey({ transactions: transactionsOk([adminRow(980001, 700, 5)]) });
  const res = await researcher.request.patch(`/api/pledges/${project.id}/${manualId}`, { data: { status: 'confirmed', apiKey: key } });
  expect(res.status()).toBe(409);
  const v = (await res.json()).error.details.verification;
  expect(v.outcome).toBe('several');
  expect(v.receipts).toMatchObject([{ id: '980001', contested: true }]);
  expect(await row('pledges', project.id, manualId)).toMatchObject({ status: 'pledged' });

  // In the dialog nothing is pre-selected and the row says why.
  await researcher.page.goto(`/projects/${project.id}`);
  await researcher.page.locator('.pledge').filter({ hasText: manualDonor.name }).getByRole('button', { name: 'Confirm received' }).click();
  const dialog = researcher.page.getByRole('dialog', { name: 'Confirm this pledge' });
  await dialog.getByLabel('RIPE Atlas API key (optional)').fill(key);
  await dialog.getByRole('button', { name: 'Check and confirm' }).click();
  await expect(dialog.locator('.alert-warn')).toContainText('another pledge of the same amount could account for that transfer');
  await expect(dialog.getByRole('radio', { name: /another pledge of the same amount could account for this one/ })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Choose a transfer' })).toBeDisabled();
});

test('a key without the read permission is refused, and nothing is recorded', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: transactionsRefused() });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-error')).toContainText('It needs the "Get information about your credits" permission');
  await expect(dialog.getByLabel('RIPE Atlas API key (optional)')).toHaveValue('');
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'sent', amountVerified: false });
  expect(JSON.stringify(await allRows())).not.toContain(FAKE_KEY_PREFIX);
});

test('RIPE not answering records nothing, and the pledged amount is one click away', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: { kind: 'json', status: 503, body: {} } });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-warn')).toHaveText('RIPE Atlas did not answer, so the amount could not be checked. Nothing was recorded. Check again, or confirm the pledged 700 credits without checking.');
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'sent' });
  await dialog.getByRole('button', { name: 'Confirm the pledged 700 credits without checking' }).click();
  await expect(dialog).toHaveCount(0);
  const pledge = researcher.page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(pledge.getByText('Verified with RIPE Atlas')).toHaveCount(0);
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'confirmed', receivedAmount: 0, amountVerified: false });
});

test('an actual amount past the ceiling is explained, and the pledged amount is offered', async ({ person }) => {
  // A request of 10 has a ceiling of 1,000. The donor pledged 10 and sent 5,000.
  const { researcher, donor, project, pledgeId } = await manualPledge(person, 10, 10);
  const key = await ownerKey({ transactions: transactionsOk([adminRow(960001, 5000, 5)]) });

  const dialog = await checkWithKey(researcher.page, project, donor, key);
  await expect(dialog.locator('.alert-warn')).toHaveText('RIPE Atlas shows 5,000 credits arrived since this pledge was made (pledged 10).');
  await dialog.getByRole('button', { name: 'Record 5,000 credits' }).click();
  await expect(dialog.locator('.alert-warn')).toContainText("Recording that would exceed the project's ceiling of 100× its request.");
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'sent' });
  await dialog.getByRole('button', { name: 'Confirm the pledged 10 credits without checking' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'confirmed', receivedAmount: 0, amountVerified: false });
});

test('a key is refused outright anywhere but the owner confirming a manual pledge', async ({ person }) => {
  const { researcher, donor, project, pledgeId } = await manualPledge(person);
  const key = await ownerKey({ transactions: transactionsOk([adminRow(970001, 700, 5)]) });

  // The donor cannot use it, and neither can the owner when cancelling.
  const asDonor = await donor.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'cancelled', apiKey: key } });
  expect(asDonor.status()).toBe(400);
  const cancelling = await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'cancelled', apiKey: key } });
  expect(cancelling.status()).toBe(400);
  // A transaction id without the key that reads it is not taken on trust.
  const bare = await researcher.request.patch(`/api/pledges/${project.id}/${pledgeId}`, { data: { status: 'confirmed', transactionId: '970001' } });
  expect(bare.status()).toBe(400);
  expect(await ripe.requests(key)).toHaveLength(0);
  expect(await row('pledges', project.id, pledgeId)).toMatchObject({ status: 'sent' });
});
