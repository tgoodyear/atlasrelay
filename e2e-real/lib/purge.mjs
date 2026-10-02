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
  // A donor is a test account when it pledged under a test name, or when every pledge it ever made
  // is on a test project. "Anonymous" alone proves nothing: anyone who pledged to a test project and
  // later deleted their profile reads that way.
  /** @type {Map<string, Row[]>} */
  const byDonor = new Map();
  for (const pl of rows.pledges) {
    const donor = s(pl.donorId);
    if (!donor) continue;
    byDonor.set(donor, [...(byDonor.get(donor) ?? []), pl]);
  }
  /** @type {{ id: string, reason: string }[]} */
  const skipped = [];
  for (const [donor, pledges] of byDonor) {
    if (candidates.has(donor) || !pledges.some((pl) => testIds.has(pl.partitionKey))) continue;
    const named = pledges.some((pl) => s(pl.donorName).startsWith(TEST_DONOR_PREFIX));
    const onlyTests = pledges.every((pl) => testIds.has(pl.partitionKey));
    const anonymous = pledges.every((pl) => s(pl.donorName) === DELETED_ACCOUNT_NAME || s(pl.donorName).startsWith(TEST_DONOR_PREFIX));
    if (named || (onlyTests && anonymous)) candidates.add(donor);
    else if (anonymous) skipped.push({ id: donor, reason: 'pledged to a test project as Anonymous and also to other projects; pass --account with every account to purge, this one included' });
  }
  const accounts = [];
  for (const id of [...candidates].sort()) {
    // The same test as the plan's: anything the account owns that is not a test project would be
    // deleted with the rest, so an account owning one is left for the operator to decide.
    const other = projects.filter((p) => s(p.ownerId) === id && !isTestProject(p)).length;
    if (other > 0) skipped.push({ id, reason: `owns ${other} project(s) the tests did not post; pass --account with every account to purge, this one included` });
    else accounts.push(id);
  }
  return { accounts, skipped: skipped.sort((a, b) => (a.id < b.id ? -1 : 1)) };
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
    // Tombstones of cleanups that did not finish (api/src/lib/store.ts, getCleanupTombstone).
    || (r.partitionKey.startsWith('cleanup-') && (gone.has(r.partitionKey.slice('cleanup-'.length)) || acct.has(s(r.ownerId))))
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
