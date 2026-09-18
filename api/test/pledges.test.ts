import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeErrorForLog, HttpError, markNotSent, NOT_SENT } from '../src/lib/http';
import { activePledgesBy, claimIsReclaimable, pledgeExpired, pledgeInFlight, pledgeUnresolved, totals } from '../src/lib/store';
import type { Pledge } from '../src/lib/store';
import { OVERFUND_MULTIPLIER, PENDING_RESERVATION_DAYS, acceptsMorePledges, capacity, maxCredits, maxSinglePledge, remainingToGoal, siteStats } from '../src/lib/pledging';

test('totals splits confirmed from pending and ignores cancelled', () => {
  const base = { id: '', projectId: '', donorId: '', donorName: '', anonymous: false, method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '', createdAt: '', updatedAt: '' };
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
  const base = { id: '', projectId: '', donorId: 'd1', donorName: '', anonymous: false, method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '', updatedAt: '' };
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
  const base = { id: '', projectId: '', donorName: '', anonymous: false, method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '', updatedAt: '' };
  const asOf = Date.parse('2026-09-17T00:00:00Z');
  const stale = new Date(asOf - (PENDING_RESERVATION_DAYS + 1) * 24 * 3600 * 1000).toISOString();
  const list = [{ ...base, donorId: 'd1', amount: 10, status: 'pledged' as const, createdAt: stale }];
  assert.equal(activePledgesBy(list, 'd1', asOf).length, 0);
});

test('a donor may hold only one live pledge per project', () => {
  const base = { id: '', projectId: '', donorName: '', anonymous: false, method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '', createdAt: '', updatedAt: '' };
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
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, amount: 1, method: 'api' as const,
    status: 'pledged' as const, transactionUrl: '', transactionId: '', transferredAt: '',
    transferUncertain: false, inFlight: false, inFlightSince: '', message: '', createdAt: recent, updatedAt: recent,
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
  const base = { id: 'a', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, method: 'api' as const, transactionUrl: '', transactionId: '', transferredAt: '2026-09-17T00:00:00.000Z', transferUncertain: true, inFlight: false, inFlightSince: '', message: '', createdAt: new Date().toISOString(), updatedAt: '' };
  const pledges = [{ ...base, amount: 500, status: 'sent' as const }];
  assert.deepEqual(totals(pledges), { confirmed: 0, pending: 500 });
  assert.equal(activePledgesBy(pledges, 'd1').length, 1);
});

test('a pledge past the reservation window counts as expired', () => {
  const day = 24 * 60 * 60 * 1000;
  const base = { id: 'a', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, method: 'manual' as const, transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '', updatedAt: '' };
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
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, amount: 1, method: 'api' as const, status,
    transactionUrl: '', transactionId: '', transferredAt: '', transferUncertain: false, inFlight: false, inFlightSince: '', message: '',
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

test('a pledge mid-transfer is not actionable, but does not freeze for ever', () => {
  // The row exists before the credits move. Confirming or cancelling in that window frees the
  // donor's slot, which would let a second pledge start while the first transfer is still running.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  const row = {
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, amount: 1, method: 'api' as const,
    status: 'pledged' as const, transactionUrl: '', transactionId: '', transferredAt: '',
    transferUncertain: false, inFlight: true, inFlightSince: '', message: '',
    createdAt: new Date(asOf - 5_000).toISOString(), updatedAt: '',
  };
  assert.equal(pledgeInFlight(row, asOf), true);
  // A request that died mid-transfer must not leave the row untouchable.
  assert.equal(pledgeInFlight({ ...row, createdAt: new Date(asOf - 5 * 60 * 1000).toISOString() }, asOf), false);
  // A resolved pledge is actionable immediately.
  assert.equal(pledgeInFlight({ ...row, inFlight: false }, asOf), false);
});

test('the in-flight window is measured from the transfer, not from the row', () => {
  // Everything before the transfer (the slot, the row, the balance check) happens first, so a
  // window anchored to createdAt could lapse before the credits were even sent, and the owner
  // could then free the slot while they were moving.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  const row = {
    id: 'p1', projectId: 'j1', donorId: 'd1', donorName: '', anonymous: false, amount: 1, method: 'api' as const,
    status: 'pledged' as const, transactionUrl: '', transactionId: '', transferredAt: '',
    transferUncertain: false, inFlight: true, inFlightSince: '', message: '',
    createdAt: new Date(asOf - 10 * 60 * 1000).toISOString(), updatedAt: '',
  };
  // Row written ten minutes ago, transfer issued five seconds ago: still in flight.
  assert.equal(pledgeInFlight({ ...row, inFlightSince: new Date(asOf - 5_000).toISOString() }, asOf), true);
  // Transfer issued long enough ago that nothing can still be running.
  assert.equal(pledgeInFlight({ ...row, inFlightSince: new Date(asOf - 5 * 60 * 1000).toISOString() }, asOf), false);
  // An unreadable anchor counts as in flight: declaring a live transfer finished is the costly way
  // to be wrong here, and the reservation expiry still frees the row eventually.
  assert.equal(pledgeInFlight({ ...row, inFlightSince: 'not a date' }, asOf), true);
  // A settled pledge is never in flight, whatever the timestamps say.
  assert.equal(pledgeInFlight({ ...row, inFlight: false, inFlightSince: new Date(asOf).toISOString() }, asOf), false);
});

test('the home-page figures count what they claim to count', () => {
  const p = (requested: number, confirmed: number, status = 'open') => ({
    status, creditsRequested: requested, creditsConfirmed: confirmed,
  });

  // Empty site.
  assert.deepEqual(siteStats([]), {
    projects: 0, openProjects: 0, creditsRequested: 0, creditsTransferred: 0, fundedProjects: 0,
  });

  const s = siteStats([
    p(1000, 0),          // open, needs all 1000
    p(1000, 400),        // open, needs 600 more
    p(1000, 1000),       // goal met, still open and still accepting
    p(1000, 500, 'closed'), // closed: not open, but its credits still count as transferred
  ]);
  // "credits currently requested" is what open projects still NEED, not what they asked for.
  assert.equal(s.creditsRequested, 1000 + 600 + 0);
  // "credits transferred" counts every project, closed ones included.
  assert.equal(s.creditsTransferred, 0 + 400 + 1000 + 500);
  // A funded project is still open and still listed, so it counts in both.
  assert.equal(s.openProjects, 3);
  // Only the project whose confirmed credits reached its request. The closed one at 500 of 1000
  // is not funded, and being closed has nothing to do with it.
  assert.equal(s.fundedProjects, 1);
  assert.equal(s.projects, 4);
});

test('a project at its ceiling stops counting as open, the same way the listing treats it', () => {
  // acceptsMorePledges is what the listing uses, so the home page must not disagree with it.
  const atCeiling = siteStats([{ status: 'open', creditsRequested: 100, creditsConfirmed: 100 * OVERFUND_MULTIPLIER }]);
  assert.equal(atCeiling.openProjects, 0, 'a project that can take no more is not an open project');
  assert.equal(atCeiling.projects, 1);
  assert.equal(atCeiling.fundedProjects, 1);
  assert.equal(atCeiling.creditsRequested, 0);
});

test('an error only says "nothing was sent" when the handler actually knows that', () => {
  // The browser decides whether to keep the transfer form live from this marker, never from the
  // status code. A status cannot answer it: the handler raises 503 on paths where it stopped
  // before sending, while a 503 from the platform edge can arrive over a transfer already in
  // flight. Reading the marker the wrong way round either strands a donor who could safely retry,
  // or invites a retry that sends the credits twice.
  const notSent = new HttpError(503, 'nothing was sent', { transfer: 'not-sent' });
  const unknown = new HttpError(503, 'edge gave up', undefined);
  const refusal = new HttpError(400, 'RIPE declined', { transfer: 'not-sent' });

  const saysNotSent = (e: HttpError): boolean =>
    (e.details as { transfer?: string } | undefined)?.transfer === 'not-sent';

  assert.equal(saysNotSent(notSent), true);
  assert.equal(saysNotSent(refusal), true, 'a refusal is a definite no-send whatever its status');
  assert.equal(saysNotSent(unknown), false, 'the same status without the marker must read as unknown');
  // The default has to be unknown, because that is the direction that cannot double-send.
  assert.equal(saysNotSent(new HttpError(500, 'internal')), false);});

test('an error raised before a transfer is issued tells the donor nothing was sent', () => {
  // Without this the browser cannot tell a rejected key from a transfer whose outcome is unknown,
  // so a donor who mistyped their key was sent to the terminal "check your RIPE Atlas account
  // before you send again" screen instead of being allowed to correct it in the open form.
  const marked = markNotSent(new HttpError(400, 'API key must be a RIPE Atlas key (UUID format)'));
  assert.ok(marked instanceof HttpError);
  assert.equal((marked as HttpError).status, 400);
  assert.equal((marked as HttpError).message, 'API key must be a RIPE Atlas key (UUID format)');
  assert.deepEqual((marked as HttpError).details, NOT_SENT);
  assert.equal((NOT_SENT as { transfer: string }).transfer, 'not-sent');
});

test('marking never overwrites what an error already said about a transfer', () => {
  // The paths that know more than "before the POST" set their own details, and the whole point of
  // the marker is that it is only ever added where the answer is certain.
  const detailed = new HttpError(409, 'Something specific', { transfer: 'sent' });
  assert.equal(markNotSent(detailed), detailed);
});

test('an unexpected failure before a transfer still says nothing was sent', () => {
  // This used to pass the error straight through, on the reasoning that a bare 500 has no details
  // channel. That reached the donor as the outcome-unknown screen, telling them to check their RIPE
  // account before sending again over a request that never got near RIPE. It is replaced by a 500
  // that carries the marker.
  const marked = markNotSent(new Error('table storage exploded: {"apiKey":"secret"}'));
  assert.ok(marked instanceof HttpError);
  assert.equal((marked as HttpError).status, 500);
  assert.deepEqual((marked as HttpError).details, NOT_SENT);
  // The original message is never published. An unknown error can carry the request body, and on
  // this route the request body holds an API key.
  assert.equal(/apiKey|exploded/.test((marked as HttpError).message), false);
});

test('an unknown error is described for the log without its message', () => {
  // SECURITY.md promises a pasted API key cannot reach a log. An unknown error is unknown: whatever
  // threw it may have folded the request body into free text, and on the pledge route that body
  // carries the donor's key. This shipped the other way round twice -- a comment saying the message
  // must not be published, with console.error(err.message) directly under it.
  const leaky = new Error('request failed: {"apiKey":"84c9393b-a2a2-4be5-8bfe-761f357ff9f0"}');
  const described = describeErrorForLog(leaky);
  assert.equal(/apiKey|84c9393b|request failed/.test(described), false);
  assert.equal(described, 'Error');

  // Azure storage errors are what actually reach these paths, and their fixed identifiers survive,
  // so the log still says something useful about what went wrong.
  const azure = Object.assign(new Error('The specified entity already exists. RequestId:...'), {
    name: 'RestError', code: 'EntityAlreadyExists', statusCode: 409,
  });
  assert.equal(describeErrorForLog(azure), 'RestError code=EntityAlreadyExists status=409');
  assert.equal(/specified entity|RequestId/.test(describeErrorForLog(azure)), false);

  // Something thrown that is not an Error at all must not be stringified either: a thrown object
  // could be the parsed request body itself.
  assert.equal(describeErrorForLog({ apiKey: 'secret' }), 'object');
  assert.equal(describeErrorForLog('84c9393b-a2a2-4be5-8bfe-761f357ff9f0'), 'string');
});

// ── Unresolved transfers (issue #22) ────────────────────────────────────────────────────────────

const unresolved = (over: Partial<Pledge> = {}): Pledge => ({
  id: 'u1', projectId: 'j1', donorId: 'd1', donorName: 'Alice', anonymous: false, amount: 100_000,
  method: 'api', status: 'sent', transactionUrl: '', transactionId: '', transferredAt: '',
  transferUncertain: true, inFlight: false, inFlightSince: '', message: '',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});
// Fifteen days after that row was created, so every age-based rule has lapsed.
const LATER = Date.parse('2026-09-16T00:00:01.000Z');

test('a transfer nobody has resolved keeps its reservation however old it is', () => {
  // This is the duplicate-transfer defect. The reservation expiry asks "has this donor abandoned their
  // reservation?", where age is real evidence. An uncertain row asks "did the credits move?", where age is
  // no evidence at all. One cutoff served both, so on day fifteen the protection simply lapsed: the slot
  // went back, the donor could pledge again, and if the original transfer had completed the credits went
  // twice. Nobody had to do anything wrong for it to happen.
  const p = unresolved();
  assert.equal(totals([p], LATER).pending, 100_000);
  assert.equal(activePledgesBy([p], 'd1', LATER).length, 1);
  assert.equal(claimIsReclaimable(p.createdAt, p, LATER), false);
  assert.equal(pledgeExpired(p, LATER), false);
});

test('a settled pledge stops holding anything, even though it still carries the flag', () => {
  // transferUncertain is never cleared: pledges-update writes `{ ...pledge, status }`, so a confirmed row
  // keeps it. A guard keyed on the flag alone would hold that row's slot and its capacity for ever, which
  // is a worse bug than the one being fixed and is invisible until somebody wonders why a project will not
  // accept pledges.
  for (const status of ['confirmed', 'cancelled'] as const) {
    const p = unresolved({ status });
    assert.equal(pledgeUnresolved(p), false, `${status} must not read as unresolved`);
    assert.equal(totals([p], LATER).pending, 0, `${status} must not reserve capacity`);
    assert.equal(activePledgesBy([p], 'd1', LATER).length, 0, `${status} must not hold the slot`);
    assert.equal(claimIsReclaimable(p.createdAt, p, LATER), true, `${status} must release the claim`);
  }
});

test('an ordinary abandoned reservation still expires', () => {
  // The fix must not turn the expiry off for the rows it was built for. A pledge nobody finished is
  // abandonment, and age really is the evidence there.
  const p = unresolved({ transferUncertain: false, status: 'pledged' });
  assert.equal(totals([p], LATER).pending, 0);
  assert.equal(activePledgesBy([p], 'd1', LATER).length, 0);
  assert.equal(claimIsReclaimable(p.createdAt, p, LATER), true);
  assert.equal(pledgeExpired(p, LATER), true);
});

test('reordering the claim check left every other answer alone', () => {
  // claimIsReclaimable had to be reordered rather than extended, because its age check returned before the
  // pledge was looked at. A reorder is where behaviour changes by accident, so enumerate the inputs it
  // already had and pin each one.
  const fresh = Date.parse('2026-09-01T00:00:05.000Z');
  const base = unresolved({ transferUncertain: false });
  // Old rows.
  assert.equal(claimIsReclaimable(base.createdAt, { ...base, status: 'pledged' }, LATER), true);
  assert.equal(claimIsReclaimable(base.createdAt, { ...base, status: 'sent' }, LATER), true);
  assert.equal(claimIsReclaimable(base.createdAt, { ...base, status: 'confirmed' }, LATER), true);
  assert.equal(claimIsReclaimable(base.createdAt, null, LATER), true);
  // Fresh rows: a live pledge holds its slot, a settled one gives it back at once, and a slot whose row
  // does not exist yet is the gap between taking the slot and writing the row.
  assert.equal(claimIsReclaimable(base.createdAt, { ...base, status: 'pledged' }, fresh), false);
  assert.equal(claimIsReclaimable(base.createdAt, { ...base, status: 'confirmed' }, fresh), true);
  assert.equal(claimIsReclaimable(base.createdAt, null, fresh), false);
  // An unreadable timestamp still means reclaimable, whatever the row says.
  assert.equal(claimIsReclaimable('not a date', { ...base, status: 'pledged' }, fresh), true);
});
