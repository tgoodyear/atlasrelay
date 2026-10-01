import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialDisplayName, privatePledge, publicName, publicPledge, publicProject, publicUser } from '../src/lib/views';
import type { Pledge, Project } from '../src/lib/store';
import { DELETED_ACCOUNT_NAME, nextResultsPostedAt, projectPatchEntity, projectUpdateArgs } from '../src/lib/store';
import { bool } from '../src/lib/validate';
import type { Tag } from '../src/lib/validate';

test('publicName never returns an email address', () => {
  // Static Web Apps supplies the email address as userDetails for some providers.
  assert.equal(publicName('trevor@example.com', 'trevor@example.com', 'abc123def'), 'trevor');
  assert.equal(publicName('', 'someone@example.org', 'abc123def'), 'someone');
  assert.equal(publicName('Alice R.', 'alice@example.org', 'abc123def'), 'Alice R.');
  assert.equal(publicName('', '', 'abc123def456'), 'user-abc123');
});

test('a new account never starts with an ORCID iD or an email address as its public name', () => {
  assert.equal(initialDisplayName('Josiah Carberry', 'orcid:abc123def'), 'Josiah Carberry');
  assert.equal(initialDisplayName('0000-0002-1825-0097', 'orcid:abc123def'), 'user-abc123');
  assert.equal(initialDisplayName('https://orcid.org/0000-0002-1694-233X', 'orcid:abc123def'), 'user-abc123');
  assert.equal(initialDisplayName('someone@gmail.com', 'google:abc123def'), 'someone');
  assert.equal(initialDisplayName('  ', 'google:abc123def'), 'user-abc123');
  assert.equal(publicName('', '', 'orcid:abc123def'), 'user-abc123');
});

test('publicName treats any at-sign as an address, not only dotted domains', () => {
  assert.equal(publicName('alice@localhost', '', 'abc123def'), 'alice');
  assert.equal(publicName('bob@intranet', 'bob@intranet', 'abc123def'), 'bob');
});

test('publicUser omits the sign-in handle entirely', () => {
  const u = {
    id: 'u1', provider: 'aad', handle: 'trevor@example.com', displayName: 'trevor@example.com',
    atlasEmail: 'secret@example.org', affiliation: 'Uni', url: '', createdAt: '', updatedAt: '',
  };
  const pub = publicUser(u) as Record<string, unknown>;
  assert.equal('handle' in pub, false);
  assert.equal('atlasEmail' in pub, false);
  assert.equal(pub.displayName, 'trevor');
  assert.equal(JSON.stringify(pub).includes('@'), false);
});

// One fixture, the same way the pledge factory below works. Every field of Project has to be
// present for the type to be satisfied, so without this each test that cares about a single field
// carries eight lines of scaffolding that say nothing, and a new field on Project means editing
// all of them. Tests below override only what they are about.
const project = (over: Partial<Project> = {}): Project => ({
  id: 'j1', ownerId: 'o1', ownerName: 'Alice', title: 't', summary: 's', description: 'd',
  creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'open', tags: [],
  affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
  resultsSummary: '', resultsUrl: '', resultsPostedAt: '',
  moderationClosed: false, createdAt: '', updatedAt: '',
  ...over,
});

test('a project read with live totals releases an expired reservation', () => {
  const p = project({ creditsRequested: 1000, creditsPending: 100_000 });
  // Cached counters say fully reserved, so nothing more can be pledged.
  assert.equal(publicProject(p).maxPledge, 0);
  // Expiry-aware totals from the read path release it.
  assert.equal(publicProject(p, { confirmed: 0, pending: 0 }).maxPledge, 1000);
});

const pledge = (over: Partial<Pledge>): Pledge => ({
  id: 'p1', projectId: 'j1', donorId: 'd1', donorName: 'Alice', anonymous: false, amount: 100, method: 'api',
  status: 'confirmed', transactionUrl: '', transactionId: '', transferredAt: '2026-09-17T00:00:00.000Z',
  transferUncertain: false, inFlight: false, inFlightSince: '', receivedAmount: 0, amountVerified: false, message: '', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  ...over,
});

test('an API transfer our server watched RIPE accept is marked as one', () => {
  assert.equal(publicPledge(pledge({})).apiTransfer, true);
});

test('a transfer RIPE never answered is never shown as a watched transfer', () => {
  // The badge asserts that our server saw RIPE accept the credits. When RIPE never replied,
  // saying so would be a claim nobody can stand behind.
  const p = publicPledge(pledge({ status: 'sent', transferUncertain: true }));
  assert.equal(p.apiTransfer, false);
  assert.equal(p.transferUncertain, true);
});

test('a manual pledge is never an API transfer', () => {
  assert.equal(publicPledge(pledge({ method: 'manual' })).apiTransfer, false);
});

test('an operator takedown flag is never published', () => {
  const p = publicProject(project({ status: 'closed', moderationClosed: true }));
  assert.equal('moderationClosed' in p, false);
});

test('a project patch stores tags the way the row reads them back', () => {
  // patchProject merges a partial row, and tags are held comma-joined. Passing the array straight
  // through would either be rejected by Table Storage or stored in a shape toProject cannot parse,
  // and the edit form submits tags on every project edit.
  const entity = projectPatchEntity('j1', { title: 'New title', tags: ['routing', 'dns'] as Tag[] });
  assert.equal(entity.tags, 'routing,dns');
  assert.equal(entity.title, 'New title');
  assert.equal(entity.rowKey, 'j1');
  // A patch that does not mention tags must not touch them.
  assert.equal('tags' in projectPatchEntity('j1', { status: 'closed' }), false);
});

test('a project never publishes its storage row version', () => {
  const p = publicProject(project({ etag: 'W/"datetime\'2026-09-18T04%3A00%3A00.0000000Z\'"' }));
  assert.equal('etag' in p, false);
});

test('a conditional project patch actually carries the row version', () => {
  // This exists because the opposite shipped: patchProject accepted an ifMatch argument and threw
  // it away, so every caller that believed it was writing conditionally was overwriting whatever
  // had landed in between, and the 412 the retry logic waits for could never arrive.
  const calls: Array<{ mode: string; options: unknown }> = [];
  const fake = {
    updateEntity: async (_e: unknown, mode: string, options: unknown) => {
      calls.push({ mode, options });
    },
  };
  void projectUpdateArgs(fake, 'j1', { status: 'closed' }, 'W/"v1"');
  assert.deepEqual(calls[0]?.options, { etag: 'W/"v1"' });
  void projectUpdateArgs(fake, 'j1', { status: 'closed' }, undefined);
  assert.equal(calls[1]?.options, undefined);
})

test('an anonymous project carries no account identifier', () => {
  // The profile page tells people the account link is internal and that retained records show
  // only their chosen display name. That has to be true of the API, not just the wording.
  const p = publicProject(project({ ownerId: 'github|12345' }));
  assert.equal('ownerId' in p, false);
  assert.equal(JSON.stringify(p).includes('github|12345'), false);
});

test('an anonymous user view carries no account identifier', () => {
  const u = publicUser({
    id: 'github|12345', provider: 'github', handle: 'alice@example.org', displayName: 'Alice',
    atlasEmail: 'alice@example.org', affiliation: '', url: '', createdAt: '', updatedAt: '',
  });
  assert.equal('id' in u, false);
  assert.equal(JSON.stringify(u).includes('github|12345'), false);
  assert.equal(JSON.stringify(u).includes('@'), false);
});

test('an anonymous pledge is not named on the public listing', () => {
  const p = publicPledge(pledge({ donorName: 'Alice R.', anonymous: true }));
  assert.equal(p.donorName, 'Anonymous');
  assert.equal(p.anonymous, true);
  // The name must not survive anywhere else in the payload.
  assert.equal(JSON.stringify(p).includes('Alice'), false);
  // What the pledge was for is still public. Only the name is withheld.
  assert.equal(p.amount, 100);
});

test('a null privacy choice is rejected rather than read as a no', () => {
  // null is a value the caller sent, not a field they left out. Treating it as absent is the same
  // silent coercion the strict reader exists to prevent, spelled differently, and it defaults to
  // publishing the name.
  assert.throws(() => bool({ anonymous: null }, 'anonymous'), /anonymous must be true or false/);
  assert.throws(() => bool({ anonymous: 'false' }, 'anonymous'), /anonymous must be true or false/);
  assert.throws(() => bool({ anonymous: 0 }, 'anonymous'), /anonymous must be true or false/);
  assert.throws(() => bool({ anonymous: 1 }, 'anonymous'), /anonymous must be true or false/);
  // Only genuinely absent, and genuine booleans, get through.
  assert.equal(bool({}, 'anonymous'), false);
  assert.equal(bool({ anonymous: undefined }, 'anonymous'), false);
  assert.equal(bool({ anonymous: true }, 'anonymous'), true);
  assert.equal(bool({ anonymous: false }, 'anonymous'), false);
});

test('an anonymous donor is not given a stable pseudonym', () => {
  // publicName falls back to user-<id prefix> when there is no display name, which is derived from
  // the account id and therefore identical on every pledge the same person makes. Using it here
  // would let anyone link an anonymous donor's pledges across projects, which is pseudonymity, not
  // anonymity. Two pledges from the same donor on different projects must look the same as two
  // pledges from different donors.
  const one = publicPledge(pledge({ id: 'a', projectId: 'j1', donorId: 'github|12345', donorName: '', anonymous: true }));
  const two = publicPledge(pledge({ id: 'b', projectId: 'j2', donorId: 'github|12345', donorName: '', anonymous: true }));
  const other = publicPledge(pledge({ id: 'c', projectId: 'j1', donorId: 'github|99999', donorName: '', anonymous: true }));
  assert.equal(one.donorName, 'Anonymous');
  assert.equal(one.donorName, two.donorName);
  assert.equal(one.donorName, other.donorName);
  assert.equal(JSON.stringify(one).includes('12345'), false);
});

test('the project owner still sees who pledged anonymously', () => {
  // They confirm the credits arrived and may need to match the pledge against their own RIPE
  // transaction log, so the name is restored on the private view. The flag travels with it so the
  // dashboard can say the name is not public.
  const p = privatePledge(pledge({ donorName: 'Alice R.', anonymous: true }));
  assert.equal(p.donorName, 'Alice R.');
  assert.equal(p.anonymous, true);
});

test('a pledge that is not anonymous is unchanged by any of this', () => {
  assert.equal(publicPledge(pledge({ donorName: 'Alice R.' })).donorName, 'Alice R.');
  assert.equal(publicPledge(pledge({ donorName: 'Alice R.' })).anonymous, false);
  assert.equal(privatePledge(pledge({ donorName: 'Alice R.' })).donorName, 'Alice R.');
});

test('an anonymous pledge still hides a sign-in address behind the name', () => {
  // publicName exists because userDetails is an email address for some providers. Anonymity must
  // not become the only thing standing between that address and a public endpoint.
  const p = publicPledge(pledge({ donorName: 'alice@example.org', anonymous: true }));
  assert.equal(p.donorName, 'Anonymous');
  const named = publicPledge(pledge({ donorName: 'alice@example.org', anonymous: false }));
  assert.equal(named.donorName, 'alice');
});

test('a deleted account is anonymous, not pseudonymous, on every view', () => {
  // Deleting a profile removes the users row and nothing else, so the display name copied onto every
  // project and pledge at creation survives. Scrubbing it has one obvious wrong answer: emptying the
  // field. publicName then falls back to user-<first 6 of the account id>, which is the same token on
  // every row that person touched, so the name would be replaced by a cross-project identifier anyone
  // can read. Storing the constant is what makes two deleted accounts indistinguishable.
  const blanked = publicName('', '', 'abc123def456');
  assert.equal(blanked, 'user-abc123');
  assert.equal(publicName('', '', 'abc123def456'), blanked, 'the fallback is stable, which is the problem');

  const one = publicName(DELETED_ACCOUNT_NAME, '', 'abc123def456');
  const two = publicName(DELETED_ACCOUNT_NAME, '', 'zzz999zzz999');
  assert.equal(one, 'Anonymous');
  assert.equal(one, two, 'two deleted accounts must read identically');
});

test('a deleted donor is anonymous to the project owner too, not just the public', () => {
  // privatePledge deliberately restores the real name through publicName, and ignores the `anonymous`
  // flag entirely, so a design built on that flag would hide the name from the listing and leave it on
  // screen for every researcher the person ever gave to. The name is stored as the constant instead,
  // which both views carry unchanged.
  const p = pledge({ donorName: DELETED_ACCOUNT_NAME, donorId: 'abc123def456', anonymous: false });
  assert.equal(publicPledge(p).donorName, 'Anonymous');
  assert.equal((privatePledge(p) as { donorName: string }).donorName, 'Anonymous');
  assert.equal(JSON.stringify(privatePledge(p)).includes('user-abc123'), false);
});

test('deleted owners cannot be enumerated through the project search', () => {
  // The public listing filters on the published owner name, so whatever replaces it is a query key on an
  // unauthenticated endpoint. An id-derived token would let anyone ask ?q=user-abc123 and get back every
  // project of one deleted account. A shared constant matches all of them and so identifies none.
  const proj = (id: string, ownerId: string, ownerName: string) => publicProject({
    id, ownerId, ownerName, title: 't', summary: 's', description: 'd',
    creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'open', tags: [],
    affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
    moderationClosed: false, resultsSummary: '', resultsUrl: '', resultsPostedAt: '',
    createdAt: '', updatedAt: '',
  });
  const a = proj('j1', 'abc123def456', DELETED_ACCOUNT_NAME);
  const b = proj('j2', 'zzz999zzz999', DELETED_ACCOUNT_NAME);
  assert.equal(a.ownerName, b.ownerName, 'the search term cannot distinguish two deleted owners');
  // And the account id itself is still not published, so the payload does not reintroduce the linkage.
  assert.equal('ownerId' in a, false);
});

test('a project says it has results only once the stamp is on the row', () => {
  // hasResults is what the listing filter, the card pill and the home-page count all read, so the
  // three of them agree only if they agree with this. Text alone is not enough: the stamp is the
  // record that a report was made, and it is the only field of the three that is write-once.
  assert.equal(publicProject(project()).hasResults, false);
  assert.equal(publicProject(project({ resultsSummary: 'We measured 40 anchors.' })).hasResults, false);
  assert.equal(publicProject(project({ resultsPostedAt: '2026-09-18T00:00:00.000Z' })).hasResults, true);
  // Reported and then trimmed to nothing. The report still happened, and the date still says when.
  assert.equal(publicProject(project({ resultsPostedAt: '2026-09-18T00:00:00.000Z', resultsSummary: '' })).hasResults, true);
});

test('publicProject survives a results row holding anything at all', () => {
  // This function runs after the credits have moved: pledges.ts returns publicProject(updated) in
  // the transfer response, so anything in here that can throw turns a completed transfer into a
  // 500 in the donor's browser and invites them to send the same credits twice. Boolean coercion
  // is total; a Date.parse or a new URL() on these three fields would not be. The row can hold
  // whatever storage holds, including values no handler would ever write.
  const nonsense = project({
    resultsPostedAt: 'not a date at all',
    resultsUrl: 'http://[',
    resultsSummary: 'x'.repeat(10_000),
  });
  const p = publicProject(nonsense, { confirmed: 100, pending: 0 });
  assert.equal(p.hasResults, true);
  assert.equal(p.funded, true);
});

test('the results stamp records when the researcher reported, not when they last saved', () => {
  // Both halves shipped wrong elsewhere in this codebase's history and both are one character
  // away here. Restamping would turn the reporting date into the date of the most recent typo
  // fix, which is the one number this feature exists to produce. Clearing on empty text would let
  // a report be withdrawn leaving a funded project looking like it never reported at all.
  const first = '2026-09-18T00:00:00.000Z';
  const later = '2026-12-25T00:00:00.000Z';
  assert.equal(nextResultsPostedAt('', { resultsSummary: 'We published on RIPE Labs.' }, first), first);
  assert.equal(nextResultsPostedAt('', { resultsUrl: 'https://labs.ripe.net/x' }, first), first);
  assert.equal(nextResultsPostedAt(first, { resultsSummary: 'We published on RIPE Labs, corrected.' }, later), first);
  assert.equal(nextResultsPostedAt(first, { resultsSummary: '', resultsUrl: '' }, later), first);
});

test('an edit that says nothing about results does not stamp one', () => {
  // readProjectFields returns only the keys the request actually sent, so a PATCH that changes a
  // title arrives here with both fields undefined. Treating that as a report would mark every
  // project on the site as having reported the next time its owner touched anything.
  assert.equal(nextResultsPostedAt('', {}, '2026-09-18T00:00:00.000Z'), '');
  // Sent, but sent empty. That is a project with no write-up, not a report of nothing.
  assert.equal(nextResultsPostedAt('', { resultsSummary: '', resultsUrl: '' }, '2026-09-18T00:00:00.000Z'), '');
});
