import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activePledgesBy, claimIsReclaimable, pledgeExpired, totals } from '../src/lib/store';
import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, OVERFUND_MULTIPLIER, PENDING_RESERVATION_DAYS, remainingToGoal } from '../src/lib/pledging';

test('totals splits confirmed from pending and ignores cancelled', () => {
  const base = { id: '', projectId: '', donorId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '', createdAt: '', updatedAt: '' };
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
  const base = { id: '', projectId: '', donorId: 'd1', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '', updatedAt: '' };
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
  const base = { id: '', projectId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00Z');
  const stale = new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * 24 * 3600 * 1000).toISOString();
  const list = [{ ...base, donorId: 'd1', amount: 10, status: 'pledged' as const, createdAt: stale }];
  assert.equal(activePledgesBy(list, 'd1', asOf).length, 0);
});

test('a donor may hold only one live pledge per project', () => {
  const base = { id: '', projectId: '', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '', createdAt: '', updatedAt: '' };
  const list = [
    { ...base, donorId: 'd1', amount: 10, status: 'pledged' as const },
    { ...base, donorId: 'd1', amount: 10, status: 'cancelled' as const },
    { ...base, donorId: 'd2', amount: 10, status: 'sent' as const },
  ];
  assert.equal(activePledgesBy(list, 'd1').length, 1);
  assert.equal(activePledgesBy(list, 'd2').length, 1);
  assert.equal(activePledgesBy(list, 'd3').length, 0);
});

test('the slot, not id ordering, is what keeps a donor to one live pledge', () => {
  // An earlier version settled this by sorting ids after the fact. That could not work: a request
  // that reads before a rival writes never sees it, so both proceed. Uniqueness now rests on
  // creating one row in the claims table, which Table Storage makes atomic. What is testable here
  // without storage is the rule that decides when a held slot may be taken from its owner.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const recent = new Date(asOf - day).toISOString();
  const live = {
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', amount: 1, method: 'api' as const,
    status: 'pledged' as const, transactionUrl: '', transactionId: '', transferredAt: '',
    transferUncertain: false, message: '', createdAt: recent, updatedAt: recent,
  };
  assert.equal(claimIsReclaimable(recent, live, asOf), false, 'a live pledge holds its slot');
  assert.equal(claimIsReclaimable(recent, { ...live, status: 'confirmed' }, asOf), true);
  assert.equal(claimIsReclaimable(recent, { ...live, status: 'cancelled' }, asOf), true);
  assert.equal(
    claimIsReclaimable(new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * day).toISOString(), live, asOf),
    true,
    'an abandoned slot frees itself rather than locking the donor out for ever',
  );
});

test('a transfer of unknown outcome keeps reserving credits and keeps its donor out', () => {
  // Parked at 'sent' because RIPE never answered. Until a human settles it, the credits it may
  // have moved stay reserved, and its donor cannot start a second transfer on the same project.
  const base = { id: 'a', projectId: 'j1', donorId: 'd1', donorName: '', method: 'api' as const, transactionUrl: '', transactionId: '', transferredAt: '2026-09-17T00:00:00.000Z', transferUncertain: true, message: '', createdAt: new Date().toISOString(), updatedAt: '' };
  const pledges = [{ ...base, amount: 500, status: 'sent' as const }];
  assert.deepEqual(totals(pledges), { confirmed: 0, pending: 500 });
  assert.equal(activePledgesBy(pledges, 'd1').length, 1);
});

test('a pledge past the reservation window counts as expired', () => {
  const day = 24 * 60 * 60 * 1000;
  const base = { id: 'a', projectId: 'j1', donorId: 'd1', donorName: '', method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00.000Z');
  const fresh = { ...base, amount: 1, status: 'pledged' as const, createdAt: new Date(asOf - 1 * day).toISOString() };
  const stale = { ...base, amount: 1, status: 'pledged' as const, createdAt: new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * day).toISOString() };
  assert.equal(pledgeExpired(fresh, asOf), false);
  assert.equal(pledgeExpired(stale, asOf), true);
  // A settled pledge never expires: its credits are already accounted for.
  assert.equal(pledgeExpired({ ...stale, status: 'confirmed' }, asOf), false);
  assert.equal(pledgeExpired({ ...stale, status: 'cancelled' }, asOf), false);
});

test('a pledge slot is reclaimable once its pledge settles, or once it goes stale', () => {
  const day = 24 * 60 * 60 * 1000;
  const asOf = Date.parse('2026-09-17T00:00:00.000Z');
  const recent = new Date(asOf - day).toISOString();
  const ancient = new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * day).toISOString();
  const pledge = (status: 'pledged' | 'sent' | 'confirmed' | 'cancelled') => ({
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', amount: 1, method: 'api' as const, status,
    transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, message: '',
    createdAt: recent, updatedAt: recent,
  });

  // A live pledge holds its slot. This is the case that stops a second transfer.
  assert.equal(claimIsReclaimable(recent, pledge('pledged'), asOf), false);
  assert.equal(claimIsReclaimable(recent, pledge('sent'), asOf), false);
  // A settled pledge releases it, even if the release call never ran.
  assert.equal(claimIsReclaimable(recent, pledge('confirmed'), asOf), true);
  assert.equal(claimIsReclaimable(recent, pledge('cancelled'), asOf), true);
  // A slot pointing at a pledge that no longer exists is not a permanent lockout.
  assert.equal(claimIsReclaimable(recent, null, asOf), true);
  // Nor is one older than the reservation window, whatever its pledge says.
  assert.equal(claimIsReclaimable(ancient, pledge('pledged'), asOf), true);
  // Nor is one with an unreadable timestamp.
  assert.equal(claimIsReclaimable('', pledge('pledged'), asOf), true);
});

test('a slot whose pledge row is not written yet stays held', () => {
  // The slot is taken before the pledge row is written. If that gap read as "free", a rival could
  // take the slot mid-flight and both requests would transfer, which is what the slot prevents.
  const asOf = Date.parse('2026-09-17T12:00:00.000Z');
  const justNow = new Date(asOf - 1_000).toISOString();
  const aWhileAgo = new Date(asOf - 5 * 60 * 1000).toISOString();
  assert.equal(claimIsReclaimable(justNow, null, asOf), false, 'a request may still be in flight');
  assert.equal(claimIsReclaimable(aWhileAgo, null, asOf), true, 'nothing can still be in flight');
});
