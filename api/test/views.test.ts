import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicName, publicProject, publicUser } from '../src/lib/views';

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
    deadline: '', createdAt: '', updatedAt: '',
  };
  // Cached counters say fully reserved, so nothing more can be pledged.
  assert.equal(publicProject(p).maxPledge, 0);
  // Expiry-aware totals from the read path release it.
  assert.equal(publicProject(p, { confirmed: 0, pending: 0 }).maxPledge, 1000);
});
