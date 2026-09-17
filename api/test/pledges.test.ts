import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activePledgesBy, pledgeExpired, totals } from '../src/lib/store';
import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, OVERFUND_MULTIPLIER, PENDING_RESERVATION_DAYS, remainingToGoal } from '../src/lib/pledging';

test('totals splits confirmed from pending and ignores cancelled', () => {
  const base = { id: '', projectId: '', donorId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', createdAt: '', updatedAt: '' };
  const t = totals([
    { ...base, amount: 100, status: 'confirmed' },
    { ...base, amount: 50, status: 'pledged' },
    { ...base, amount: 25, status: 'sent' },
    { ...base, amount: 999, status: 'cancelled' },
  ]);
  assert.deepEqual(t, { confirmed: 100, pending: 75 });
});

test('projects accept credits up to 100x their request', () => {
  assert.equal(OVERFUND_MULTIPLIER, 100);
  assert.equal(maxCredits(1000), 100_000);
  assert.equal(capacity(1000, 0), 100_000);
  assert.equal(capacity(1000, 1000), 99_000); // funded but still accepting
  assert.equal(capacity(1000, 100_000), 0); // ceiling reached
  assert.equal(capacity(1000, 150_000), 0); // never negative
  assert.equal(remainingToGoal(1000, 250), 750);
  assert.equal(remainingToGoal(1000, 5000), 0);
});

test('pending pledges reserve capacity', () => {
  assert.equal(capacity(1000, 90_000, 10_000), 0); // fully reserved by pending pledges
  assert.equal(capacity(1000, 90_000, 4_000), 6_000);
});

test('no single pledge can reserve the whole ceiling', () => {
  // Before the goal is met, one pledge may at most complete the goal.
  assert.equal(maxSinglePledge(1000, 0, 0), 1000);
  assert.equal(maxSinglePledge(1000, 250, 0), 750);
  // Once the goal is met, a pledge may add at most one further goal's worth.
  assert.equal(maxSinglePledge(1000, 1000, 0), 1000);
  // Never more than the remaining capacity.
  assert.equal(maxSinglePledge(1000, 99_500, 0), 500);
  assert.equal(maxSinglePledge(1000, 99_000, 500), 500);
});

test('listing keys off confirmed credits, so a pending pledge cannot hide a project', () => {
  assert.equal(acceptsMorePledges(1000, 0), true);
  assert.equal(acceptsMorePledges(1000, 99_999), true);
  assert.equal(acceptsMorePledges(1000, 100_000), false);
});

test('stale pending pledges stop reserving capacity', () => {
  const base = { id: '', projectId: '', donorId: 'd1', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00Z');
  const fresh = new Date(asOf - 1 * 24 * 3600 * 1000).toISOString();
  const stale = new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * 24 * 3600 * 1000).toISOString();
  const t = totals([
    { ...base, amount: 100, status: 'pledged', createdAt: fresh },
    { ...base, amount: 900, status: 'pledged', createdAt: stale },
  ], asOf);
  assert.deepEqual(t, { confirmed: 0, pending: 100 });
});

test('an expired pledge no longer locks its own donor out', () => {
  const base = { id: '', projectId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00Z');
  const stale = new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * 24 * 3600 * 1000).toISOString();
  const list = [{ ...base, donorId: 'd1', amount: 10, status: 'pledged' as const, createdAt: stale }];
  assert.equal(activePledgesBy(list, 'd1', asOf).length, 0);
});

test('a donor may hold only one live pledge per project', () => {
  const base = { id: '', projectId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', createdAt: '', updatedAt: '' };
  const list = [
    { ...base, donorId: 'd1', amount: 10, status: 'pledged' as const },
    { ...base, donorId: 'd1', amount: 10, status: 'cancelled' as const },
    { ...base, donorId: 'd2', amount: 10, status: 'sent' as const },
  ];
  assert.equal(activePledgesBy(list, 'd1').length, 1);
  assert.equal(activePledgesBy(list, 'd2').length, 1);
  assert.equal(activePledgesBy(list, 'd3').length, 0);
});

test('concurrent pledges from one donor settle on the lowest id, deterministically', () => {
  // Ids are time-prefixed and sortable, so every racing request picks the same winner
  // without coordination, which is what makes the post-write settlement safe.
  const base = { projectId: '', donorId: 'd1', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', createdAt: '', updatedAt: '', amount: 10, status: 'pledged' as const };
  const racing = [{ ...base, id: '0mu45rmy60912b13q' }, { ...base, id: '0mu45rmy10912b13q' }, { ...base, id: '0mu45rmz00912b13q' }];
  const winner = activePledgesBy(racing, 'd1').map((x) => x.id).sort()[0];
  assert.equal(winner, '0mu45rmy10912b13q');
  // Every participant computes the same answer regardless of the order it sees them in.
  for (const order of [[2, 0, 1], [1, 2, 0], [0, 1, 2]]) {
    const shuffled = order.map((i) => racing[i]);
    assert.equal(activePledgesBy(shuffled, 'd1').map((x) => x.id).sort()[0], winner);
  }
});

test('a pledge past the reservation window counts as expired', () => {
  const day = 24 * 60 * 60 * 1000;
  const base = { id: 'a', projectId: 'j1', donorId: 'd1', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00.000Z');
  const fresh = { ...base, amount: 1, status: 'pledged' as const, createdAt: new Date(asOf - 1 * day).toISOString() };
  const stale = { ...base, amount: 1, status: 'pledged' as const, createdAt: new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * day).toISOString() };
  assert.equal(pledgeExpired(fresh, asOf), false);
  assert.equal(pledgeExpired(stale, asOf), true);
  // A settled pledge never expires: its credits are already accounted for.
  assert.equal(pledgeExpired({ ...stale, status: 'confirmed' }, asOf), false);
  assert.equal(pledgeExpired({ ...stale, status: 'cancelled' }, asOf), false);
});
