import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicName, publicPledge, publicProject, publicUser } from '../src/lib/views';
import type { Pledge } from '../src/lib/store';

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

const pledge = (over: Partial<Pledge>): Pledge => ({
  id: 'p1', projectId: 'j1', donorId: 'd1', donorName: 'Alice', amount: 100, method: 'api',
  status: 'confirmed', transactionUrl: '', transactionId: '', transferredAt: '2026-09-17T00:00:00.000Z',
  transferUncertain: false, inFlight: false, message: '', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
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

test('a project never publishes its storage row version', () => {
  const p = publicProject({
    id: 'j1', ownerId: 'o1', ownerName: 'Alice', title: 't', summary: 's', description: 'd',
    creditsRequested: 100, creditsConfirmed: 0, creditsPending: 0, status: 'open', tags: [],
    affiliation: '', homepageUrl: '', repoUrl: '', paperUrl: '', deadline: '',
    etag: 'W/"datetime\'2026-09-18T04%3A00%3A00.0000000Z\'"', createdAt: '', updatedAt: '',
  });
  assert.equal('etag' in p, false);
});
