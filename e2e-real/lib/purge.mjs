// What scripts/purge-test-data.mjs removes from a test environment's tables: everything the
// full-flow test accounts posted before the tests cleaned up after themselves. Pure, so the rules
// can be tested; the script does the reading and the deleting.
//
// The test accounts are found from their projects. Every project the full-flow tests have ever
// posted has a title starting "E2E " and a description starting "Posted by the Atlas Relay
// full-flow tests", so the owners of those are the researcher accounts, and the donors who pledged
// to them under a test name (or under "Anonymous", which is what a deleted profile leaves) are the
// donor accounts. An account that also owns a project not titled like a test is left out unless the
// operator names it, so a person who happened to pledge to a test project on dev is never swept up.

/** @typedef {{ partitionKey: string, rowKey: string, [key: string]: unknown }} Row */

export const TEST_TITLE_PREFIX = 'E2E ';
export const TEST_DESCRIPTION_PREFIX = 'Posted by the Atlas Relay full-flow tests';
/** DELETED_ACCOUNT_NAME in api/src/lib/store.ts: what a deleted profile leaves on its rows. */
export const DELETED_ACCOUNT_NAME = 'Anonymous';
export const TEST_DONOR_PREFIX = 'E2E donor ';

/** @param {unknown} v */
const s = (v) => (typeof v === 'string' ? v : '');

/** @param {Row} p a row of the project partition */
export function isTestProject(p) {
  return s(p.title).startsWith(TEST_TITLE_PREFIX) && s(p.description).startsWith(TEST_DESCRIPTION_PREFIX);
}

/**
 * @param {{ projects: Row[], pledges: Row[] }} rows
 * @returns {{ accounts: string[], skipped: { id: string, reason: string }[] }}
 */
export function detectTestAccounts(rows) {
  const projects = rows.projects.filter((r) => r.partitionKey === 'project');
  const testIds = new Set(projects.filter(isTestProject).map((p) => p.rowKey));
  /** @type {Set<string>} */
  const candidates = new Set(projects.filter(isTestProject).map((p) => s(p.ownerId)).filter(Boolean));
  for (const pl of rows.pledges) {
    if (!testIds.has(pl.partitionKey)) continue;
    const name = s(pl.donorName);
    if (name === DELETED_ACCOUNT_NAME || name.startsWith(TEST_DONOR_PREFIX)) {
      const donor = s(pl.donorId);
      if (donor) candidates.add(donor);
    }
  }
  const accounts = [];
  const skipped = [];
  for (const id of [...candidates].sort()) {
    const other = projects.filter((p) => s(p.ownerId) === id && !s(p.title).startsWith(TEST_TITLE_PREFIX)).length;
    if (other > 0) skipped.push({ id, reason: `owns ${other} project(s) not titled like a test; name it with --account to include it` });
    else accounts.push(id);
  }
  return { accounts, skipped };
}

/**
 * Every row to delete, and the projects whose cached totals have to be rebuilt because a pledge
 * of theirs goes. The table rows are what the API's own cleanup removes per project
 * (deleteProjectRecords in api/src/lib/store.ts), for every project the accounts own, plus the
 * accounts' pledges and pledge slots on anybody else's project.
 *
 * @param {{ projects: Row[], pledges: Row[], claims: Row[] }} rows every row of the three tables
 * @param {string[]} accounts
 */
export function planPurge(rows, accounts) {
  const acct = new Set(accounts);
  if (acct.size === 0) throw new Error('No test accounts to purge');
  const projectRows = rows.projects.filter((r) => r.partitionKey === 'project' && acct.has(s(r.ownerId)));
  const gone = new Set(projectRows.map((r) => r.rowKey));
  const indexRows = rows.projects.filter((r) => [...acct].some((a) => r.partitionKey === `owner-${a}`));
  const pledgeRows = rows.pledges.filter((r) => gone.has(r.partitionKey) || acct.has(s(r.donorId)));
  const claimRows = rows.claims.filter((r) =>
    gone.has(r.partitionKey)
    || (r.partitionKey.startsWith('confirm-') && gone.has(r.partitionKey.slice('confirm-'.length)))
    || [...acct].some((a) => r.partitionKey === `receipt-${a}`)
    // The accounts' pledge slots on projects that stay.
    || (acct.has(r.rowKey) && rows.projects.some((p) => p.partitionKey === 'project' && p.rowKey === r.partitionKey)));
  const dirty = [...new Set(pledgeRows.map((r) => r.partitionKey).filter((id) => !gone.has(id)))].sort();
  const remaining = rows.projects.filter((r) => r.partitionKey === 'project' && !gone.has(r.rowKey));
  return {
    projects: projectRows,
    index: indexRows,
    pledges: pledgeRows,
    claims: claimRows,
    /** Projects that stay but lose a pledge: marked totalsDirty so the listing rebuilds their totals. */
    dirty,
    remaining: {
      projects: remaining.length,
      withCredits: remaining.filter((r) => Number(r.creditsConfirmed ?? 0) > 0).length,
    },
  };
}
