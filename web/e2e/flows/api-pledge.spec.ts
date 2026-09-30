import type { Page } from '@playwright/test';
import {
  FAKE_KEY_PREFIX,
  allRows,
  expect,
  fakeKey,
  postProject,
  recordResponses,
  ripe,
  stackLog,
  test,
  type CreatedProject,
  type Person,
} from './fixtures';
import { balanceOk, balanceRefused, transferBadRequest, transferCreated, transferForbidden, type Scenario } from './harness/ripe-stub';

// A donor pastes a RIPE Atlas API key and the API makes the transfer. The RIPE Atlas API is the
// stub in harness/ripe-stub.ts, answering per key as each test tells it to.

async function openApiPledge(page: Page, project: CreatedProject, key: string, amount: number) {
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: 'Send credits' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /Transfer now with an API key/ })).toBeChecked();
  await dialog.getByLabel('Amount').fill(String(amount));
  await dialog.getByLabel('RIPE Atlas API key').fill(key);
  return dialog;
}

async function setup(person: (o: { role: string }) => Promise<Person>, credits = 1000) {
  const researcher = await person({ role: 'researcher' });
  const donor = await person({ role: 'donor' });
  const project = await postProject(researcher, { creditsRequested: credits });
  return { researcher, donor, project };
}

/** Wait for the API's own log line about this transfer, so the log is complete before it is searched. */
async function transferLogged(projectId: string, outcome: string): Promise<string> {
  await expect.poll(() => stackLog('func').includes(`"outcome":"${outcome}","projectId":"${projectId}"`), { timeout: 10_000 }).toBe(true);
  return stackLog('func');
}

test('API pledge: balance check, one transfer, confirmed at once, and the key is kept nowhere', async ({ person }) => {
  const { researcher, donor, project } = await setup(person);
  const key = fakeKey();
  await ripe.scenario(key, { balance: balanceOk(250_000), transfer: transferCreated() });
  const responses = recordResponses(donor.page);

  const dialog = await openApiPledge(donor.page, project, key, 300);
  await dialog.getByRole('button', { name: 'Check balance' }).click();
  await expect(dialog.getByText('Balance: 250,000 credits')).toBeVisible();
  await dialog.getByRole('button', { name: 'Transfer 300 credits' }).click();

  const done = donor.page.getByRole('dialog', { name: 'Credits transferred' });
  await expect(done.getByText('RIPE Atlas accepted the transfer of 300 credits. The pledge is confirmed.')).toBeVisible();
  await expect(done.getByText('Remember to delete or disable the API key you used')).toBeVisible();
  await expect(done.getByRole('link', { name: 'atlas.ripe.net/keys' })).toHaveAttribute('href', 'https://atlas.ripe.net/keys/');
  await done.getByRole('button', { name: 'Done' }).click();

  const pledge = donor.page.locator('.pledge').filter({ hasText: donor.name });
  await expect(pledge.getByText('Transferred via API')).toBeVisible();
  await expect(pledge).toContainText('via API');
  await expect(donor.page.locator('dl.kv')).toContainText('Received300');

  // The stub saw two balance reads (the button, then the pledge) and exactly one transfer, to the
  // researcher's RIPE address, for the amount pledged.
  const seen = await ripe.requests(key);
  expect(seen.filter((r) => r.method === 'GET' && r.path === '/api/v2/credits/')).toHaveLength(2);
  const transfers = await ripe.transfers(key);
  expect(transfers).toHaveLength(1);
  expect(transfers[0].body).toEqual({ recipient: researcher.email, amount: 300 });

  // The researcher sees it confirmed without doing anything.
  await researcher.page.goto(`/projects/${project.id}`);
  await expect(researcher.page.locator('.pledge').filter({ hasText: donor.name }).getByText('Transferred via API')).toBeVisible();

  // The key is in no response the browser got, no stored row, and no log line.
  const bodies = await responses();
  expect(bodies.some((b) => b.startsWith(`POST /api/projects/${project.id}/pledges`))).toBe(true);
  for (const body of bodies) expect(body, body.split('\n')[0]).not.toContain(key);
  const stored = JSON.stringify(await allRows());
  expect(stored).not.toContain(key);
  expect(stored).not.toContain(FAKE_KEY_PREFIX);
  const funcLog = await transferLogged(project.id, 'confirmed');
  expect(funcLog).not.toContain(FAKE_KEY_PREFIX);
  expect(stackLog('swa')).not.toContain(FAKE_KEY_PREFIX);
  expect(stackLog('azurite')).not.toContain(FAKE_KEY_PREFIX);
});

test('API pledge with a transfer-only key: the balance read is refused and the transfer goes ahead', async ({ person }) => {
  const { donor, project } = await setup(person);
  const key = fakeKey();
  await ripe.scenario(key, { balance: balanceRefused(), transfer: transferCreated() });

  const dialog = await openApiPledge(donor.page, project, key, 150);
  await dialog.getByRole('button', { name: 'Check balance' }).click();
  await expect(dialog.locator('.alert-error')).toHaveText('You do not have permission to perform this action.');
  await dialog.getByRole('button', { name: 'Transfer 150 credits' }).click();

  const done = donor.page.getByRole('dialog', { name: 'Credits transferred' });
  await expect(done.getByText('The pledge is confirmed.')).toBeVisible();
  await expect(done.locator('.alert-warn')).toHaveText(
    'Your balance was not checked first; the key appears to lack the "Get information about your credits" permission.',
  );
  expect(await ripe.transfers(key)).toHaveLength(1);
});

const refusals: { name: string; transfer: Scenario['transfer']; shown: string }[] = [
  {
    name: '403: the key may not transfer',
    transfer: transferForbidden(),
    shown: 'You do not have permission to perform this action.',
  },
  {
    name: '400: RIPE rejects the recipient, and its detail is shown',
    transfer: transferBadRequest('No RIPE NCC Access account uses this email address.'),
    shown: 'recipient: No RIPE NCC Access account uses this email address.',
  },
];

for (const r of refusals) {
  test(`API pledge refused with ${r.name}; the pledge is cancelled and the donor can try again`, async ({ person }) => {
    const { donor, project } = await setup(person);
    const key = fakeKey();
    await ripe.scenario(key, { balance: balanceOk(10_000), transfer: r.transfer });

    const dialog = await openApiPledge(donor.page, project, key, 200);
    await dialog.getByRole('button', { name: 'Transfer 200 credits' }).click();
    // RIPE refused, so the form stays open with RIPE's reason and the key field cleared.
    await expect(dialog.locator('.alert-error')).toHaveText(r.shown);
    await expect(dialog.getByRole('heading', { name: 'Send credits' })).toBeVisible();
    await expect(dialog.getByLabel('RIPE Atlas API key')).toHaveValue('');
    expect(await ripe.transfers(key)).toHaveLength(1);

    const project1 = (await (await donor.request.get(`/api/projects/${project.id}`)).json()).project;
    expect(project1).toMatchObject({ creditsConfirmed: 0, creditsPending: 0 });
    const mine = (await (await donor.request.get(`/api/projects/${project.id}/pledges`)).json()).pledges;
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('cancelled');

    // Nothing moved, so the slot is free: the same dialog sends with a working key.
    const good = fakeKey();
    await ripe.scenario(good, { balance: balanceOk(10_000), transfer: transferCreated() });
    await dialog.getByLabel('RIPE Atlas API key').fill(good);
    await dialog.getByRole('button', { name: 'Transfer 200 credits' }).click();
    await expect(donor.page.getByRole('dialog', { name: 'Credits transferred' })).toBeVisible();
    expect(await ripe.transfers(good)).toHaveLength(1);
  });
}

test('API pledge stops before sending when the balance is too low', async ({ person }) => {
  const { donor, project } = await setup(person);
  const key = fakeKey();
  await ripe.scenario(key, { balance: balanceOk(120), transfer: transferCreated() });

  const dialog = await openApiPledge(donor.page, project, key, 500);
  await dialog.getByRole('button', { name: 'Check balance' }).click();
  await expect(dialog.getByText('Balance: 120 credits (less than the amount)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Transfer 500 credits' }).click();
  await expect(dialog.locator('.alert-error')).toHaveText('Your RIPE Atlas balance is 120 credits, less than the 500 you want to send');
  expect(await ripe.transfers(key)).toHaveLength(0);
});

const unknowns: { name: string; transfer: Scenario['transfer']; said: string }[] = [
  // Waits out the API's 20 second transfer deadline.
  { name: 'RIPE never answers', transfer: { kind: 'hang' }, said: 'RIPE Atlas did not respond in time.' },
  { name: 'the connection drops', transfer: { kind: 'drop' }, said: 'Could not reach RIPE Atlas.' },
];

for (const u of unknowns) {
  test(`API pledge where ${u.name}: parked as uncertain, cannot be sent twice, and the owner settles it`, async ({ person }) => {
    test.setTimeout(90_000);
    const { researcher, donor, project } = await setup(person);
    const key = fakeKey();
    await ripe.scenario(key, { balance: balanceOk(10_000), transfer: u.transfer });

    const dialog = await openApiPledge(donor.page, project, key, 250);
    await dialog.getByRole('button', { name: 'Transfer 250 credits' }).click();

    const unknown = donor.page.getByRole('dialog', { name: 'Check before you send again' });
    await expect(unknown.locator('.alert-warn')).toContainText(u.said, { timeout: 40_000 });
    await expect(unknown.getByText('We cannot tell you whether the 250 credits left your account.')).toBeVisible();
    await expect(unknown.getByText('If it is there, the transfer worked. The pledge is already recorded')).toBeVisible();
    await expect(unknown.getByRole('link', { name: 'atlas.ripe.net/credits/transactions' })).toHaveAttribute('href', 'https://atlas.ripe.net/credits/transactions/');
    // No way to send again from here.
    await expect(unknown.getByRole('button', { name: /Transfer/ })).toHaveCount(0);
    await expect(unknown.getByLabel('RIPE Atlas API key')).toHaveCount(0);
    await unknown.getByRole('button', { name: 'Done' }).click();

    const pledge = donor.page.locator('.pledge').filter({ hasText: donor.name });
    await expect(pledge.getByText('Sent, outcome unknown')).toBeVisible();
    await expect(pledge.getByText('Waiting for the project owner to settle this')).toBeVisible();
    await expect(pledge.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    // A second attempt, even with another key, is refused before anything reaches RIPE.
    const second = fakeKey();
    await ripe.scenario(second, { balance: balanceOk(10_000), transfer: transferCreated() });
    const retry = await openApiPledge(donor.page, project, second, 250);
    await retry.getByRole('button', { name: 'Transfer 250 credits' }).click();
    await expect(retry.locator('.alert-error')).toHaveText('You already have a pledge in progress on this project. Complete or cancel it first.');
    expect(await ripe.requests(second)).toHaveLength(0);
    expect(await ripe.transfers(key)).toHaveLength(1);

    // Nor can the donor cancel it through the API.
    const mine = (await (await donor.request.get(`/api/projects/${project.id}/pledges`)).json()).pledges;
    const cancel = await donor.request.patch(`/api/pledges/${project.id}/${mine[0].id}`, { data: { status: 'cancelled' } });
    expect(cancel.status()).toBe(409);

    // The donor's dashboard says who acts next.
    await donor.page.goto('/dashboard');
    await donor.page.getByRole('tab', { name: /My pledges/ }).click();
    const row = donor.page.getByRole('row').filter({ hasText: project.title });
    await expect(row).toContainText('Sent, outcome unknown');
    await expect(row).toContainText('Waiting for the project owner to confirm receipt');
    await expect(row.getByRole('button')).toHaveCount(0);

    // The owner settles it.
    await researcher.page.goto(`/projects/${project.id}`);
    const ownerRow = researcher.page.locator('.pledge').filter({ hasText: donor.name });
    await expect(ownerRow.getByText('Sent, outcome unknown')).toBeVisible();
    await ownerRow.getByRole('button', { name: 'Confirm received' }).click();
    await expect(ownerRow.getByText('Confirmed', { exact: true })).toBeVisible();
    await expect(researcher.page.locator('dl.kv')).toContainText('Received250');

    const funcLog = await transferLogged(project.id, 'uncertain');
    expect(funcLog).not.toContain(FAKE_KEY_PREFIX);
    expect(JSON.stringify(await allRows())).not.toContain(FAKE_KEY_PREFIX);
  });
}
