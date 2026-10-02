#!/usr/bin/env node
// Removes what the full-flow test accounts left in a test environment's tables before the tests
// deleted their own projects. Run it through scripts/purge-test-data.sh, which reads the
// environment's settings and refuses prod; this checks again.
//
//   PURGE_ENV=dev PURGE_STORAGE_ACCOUNT=<account> [PURGE_TENANT_ID=<tenant>] \
//     node scripts/purge-test-data.mjs [--apply] [--account <id>]...
//
// Signs in to Table Storage as the operator through the Azure CLI (the same identity as
// `az storage entity ... --auth-mode login`), which needs Storage Table Data Contributor on the
// account (infra/app.bicep, operatorTables). Without --apply it only prints what it would delete.
// Prints account and project ids and counts, never names, emails or titles.
import { TableClient, odata } from '@azure/data-tables';
import { AzureCliCredential } from '@azure/identity';
import { detectTestAccounts, planPurge } from '../e2e-real/lib/purge.mjs';

const log = (line) => console.log(`[purge] ${line}`);
function die(message) {
  console.error(`[purge] error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const named = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') continue;
  if (args[i] === '--account' && args[i + 1]) named.push(args[++i]);
  else die(`unknown argument ${args[i]}`);
}

const env = process.env.PURGE_ENV ?? '';
const account = process.env.PURGE_STORAGE_ACCOUNT ?? '';
if (!/^[a-z][a-z0-9]{0,5}$/.test(env)) die('PURGE_ENV must name the environment');
if (env === 'prod') die('refusing to run against prod');
// The data account is statlasrelay<env><suffix> (infra/main.bicep), so a prod account cannot pass.
if (!account.startsWith(`statlasrelay${env}`) || account.startsWith('statlasrelayprod')) {
  die(`storage account ${account || '(unset)'} is not ${env}'s data account`);
}

const endpoint = `https://${account}.table.core.windows.net`;
const credential = new AzureCliCredential(process.env.PURGE_TENANT_ID ? { tenantId: process.env.PURGE_TENANT_ID } : {});
const client = (name) => new TableClient(endpoint, name, credential);
const tables = { projects: client('projects'), pledges: client('pledges'), claims: client('claims') };

async function all(t) {
  const rows = [];
  for await (const e of t.listEntities()) rows.push(e);
  return rows;
}

const rows = { projects: await all(tables.projects), pledges: await all(tables.pledges), claims: await all(tables.claims) };
log(`${env} (${account}): ${rows.projects.filter((r) => r.partitionKey === 'project').length} projects, ${rows.pledges.length} pledges, ${rows.claims.length} claim rows`);

let accounts = named;
if (accounts.length === 0) {
  const found = detectTestAccounts(rows);
  for (const s of found.skipped) log(`not included: account ${s.id} ${s.reason}`);
  accounts = found.accounts;
}
if (accounts.length === 0) {
  log('no test accounts found; nothing to do');
  process.exit(0);
}
for (const a of accounts) {
  const owned = rows.projects.filter((r) => r.partitionKey === 'project' && r.ownerId === a).length;
  const pledged = rows.pledges.filter((r) => r.donorId === a).length;
  log(`test account ${a}: owns ${owned} project(s), made ${pledged} pledge(s)`);
}

const plan = planPurge(rows, accounts);
log(`to delete: ${plan.projects.length} project(s), ${plan.index.length} owner index row(s), ${plan.pledges.length} pledge(s), ${plan.claims.length} claim row(s)`);
if (plan.dirty.length) log(`projects that stay but lose a pledge, to have their totals rebuilt: ${plan.dirty.join(', ')}`);
log(`left afterwards: ${plan.remaining.projects} project(s), ${plan.remaining.withCredits} with credits received`);

if (!apply) {
  log('dry run: nothing deleted. Run again with --apply to delete.');
  process.exit(0);
}

let failed = 0;
async function remove(t, r) {
  try {
    await t.deleteEntity(r.partitionKey, r.rowKey);
    return 1;
  } catch (err) {
    if (err?.statusCode === 404) return 0;
    failed += 1;
    console.error(`[purge] could not delete ${r.partitionKey}/${r.rowKey}: HTTP ${err?.statusCode ?? 'error'}`);
    return 0;
  }
}
// Every step leaves something the next run can find, so a run that stops part way can simply be run
// again. The projects that lose a pledge are marked first, because once their pledge is gone nothing
// would lead a later run back to them; if any cannot be marked, nothing is deleted. Then the pledges
// and claim rows, then the project rows, and their owner index rows last: an index row with no
// project behind it is skipped by every reader, while a project row with no index row would be a
// live project its owner's dashboard, the open-project cap and profile deletion could not see.
for (const id of plan.dirty) {
  try {
    await tables.projects.updateEntity({ partitionKey: 'project', rowKey: id, totalsDirty: true }, 'Merge');
  } catch (err) {
    failed += 1;
    console.error(`[purge] could not mark project ${id} for a totals rebuild: HTTP ${err?.statusCode ?? 'error'}`);
  }
}
if (failed) die(`${failed} project(s) could not be marked for a totals rebuild; nothing was deleted. Run again to retry.`);
const n = { pledges: 0, claims: 0, index: 0, projects: 0 };
for (const r of plan.pledges) n.pledges += await remove(tables.pledges, r);
for (const r of plan.claims) n.claims += await remove(tables.claims, r);
for (const r of plan.projects) n.projects += await remove(tables.projects, r);
for (const r of plan.index) n.index += await remove(tables.projects, r);
log(`deleted ${n.projects} project(s), ${n.index} owner index row(s), ${n.pledges} pledge(s), ${n.claims} claim row(s)`);
const left = [];
for await (const e of tables.projects.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${'project'}`, select: ['RowKey'] } })) left.push(e.rowKey);
log(`projects now in ${env}: ${left.length}`);
if (failed) die(`${failed} row(s) could not be changed; run again to retry`);
