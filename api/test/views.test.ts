import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicName, publicPledge, publicProject, publicUser } from '../src/lib/views';
import type { Pledge } from '../src/lib/store';
import { projectPatchEntity } from '../src/lib/store';
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
