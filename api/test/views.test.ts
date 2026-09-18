import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privatePledge, publicName, publicPledge, publicProject, publicUser } from '../src/lib/views';
import type { Pledge } from '../src/lib/store';
import { projectPatchEntity, projectUpdateArgs } from '../src/lib/store';
import { bool } from '../src/lib/validate';
import type { Tag } from '../src/lib/validate';

test('publicName never returns an email address', () => {
  // Static Web Apps supplies the email address as userDetails for some providers.
  assert.equal(publicName('trevor@example.com', 'trevor@example.com', 'abc123def'), 'trevor');
  assert.equal(publicName('', 'someone@example.org', 'abc123def'), 'someone');
  assert.equal(publicName('Alice R.', 'alice@example.org', 'abc123def'), 'Alice R.');
  assert.equal(publicName('', '', 'abc123def456'), 'user-abc123');
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

test('a project read with live totals releases an expired reservation', () => {
  const p = {
    id: 'p1', ownerId: 'o1', ownerName: 'Owner', title: 't', summary: 's', description: 'd',
    creditsRequested: 1000, creditsConfirmed: 0, creditsPending: 100_000,
    status: 'open' as const, tags: [], affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '',
    deadline: '', moderationClosed: false, createdAt: '', updatedAt: '',
  };
  // Cached counters say fully reserved, so nothing more can be pledged.
  assert.equal(publicProject(p).maxPledge, 0);
  // Expiry-aware totals from the read path release it.
  assert.equal(publicProject(p, { confirmed: 0, pending: 0 }).maxPledge, 1000);
});

const pledge = (over: Partial<Pledge>): Pledge => ({
  id: 'p1', projectId: 'j1', donorId: 'd1', donorName: 'Alice', anonymous: false, amount: 100, method: 'api',
  status: 'confirmed', transactionUrl: '', transactionId: '', transferredAt: '2026-09-17T00:00:00.000Z',
  transferUncertain: false, inFlight: false, inFlightSince: '', message: '', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
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
  const p = publicProject({
    id: 'j1', ownerId: 'o1', ownerName: 'Alice', title: 't', summary: 's', description: 'd',
    creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'closed', tags: [],
    affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
    moderationClosed: true, createdAt: '', updatedAt: '',
  });
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
  const p = publicProject({
    id: 'j1', ownerId: 'o1', ownerName: 'Alice', title: 't', summary: 's', description: 'd',
    creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'open', tags: [],
    affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
    moderationClosed: false, etag: 'W/"datetime\'2026-09-18T04%3A00%3A00.0000000Z\'"',
    createdAt: '', updatedAt: '',
  });
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
  const p = publicProject({
    id: 'j1', ownerId: 'github|12345', ownerName: 'Alice', title: 't', summary: 's', description: 'd',
    creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'open', tags: [],
    affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
    moderationClosed: false, createdAt: '', updatedAt: '',
  });
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
