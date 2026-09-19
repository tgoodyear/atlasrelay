import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OPEN_PROJECTS_PER_USER,
  PROJECT_POST_INTERVAL_MS,
  capSettlement,
  projectPostAllowed,
  surplusOpenProjects,
} from '../src/lib/pledging';

const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id);
const open = (...list: string[]): { id: string }[] => list.map((id) => ({ id }));

test('the cap gives up an owner\'s newest projects and keeps the ones already there', () => {
  // Ids are time-prefixed, so ordering by id is ordering by age. Every racing request reaches the
  // same verdict from the same rows without coordinating, which is the whole reason the cap can be
  // settled after the write instead of reserved before it.
  const surplus = surplusOpenProjects(open('p5', 'p1', 'p4', 'p2', 'p3'), MAX_OPEN_PROJECTS_PER_USER);
  assert.deepEqual(ids(surplus), ['p4', 'p5']);
});

test('an owner at the cap gives up nothing', () => {
  assert.deepEqual(surplusOpenProjects(open('p1', 'p2', 'p3'), MAX_OPEN_PROJECTS_PER_USER), []);
  assert.deepEqual(surplusOpenProjects(open('p1'), MAX_OPEN_PROJECTS_PER_USER), []);
  assert.deepEqual(surplusOpenProjects([], MAX_OPEN_PROJECTS_PER_USER), []);
});

test('choosing the surplus does not reorder the list it was asked about', () => {
  // The previous implementation sorted the caller's array in place. Nothing read it afterwards, so
  // it was harmless there, but a rule that rewrites its input cannot be reasoned about or reused.
  const mine = open('p3', 'p1', 'p2', 'p4');
  surplusOpenProjects(mine, MAX_OPEN_PROJECTS_PER_USER);
  assert.deepEqual(ids(mine), ['p3', 'p1', 'p2', 'p4']);
});

test('a surplus close that did not land is not reported as the caller being refused', () => {
  // This is what shipped. The settlement returned the set it had selected for closing, so when the
  // best-effort close of the caller's own project failed, the handler still answered 409 "you
  // already have 3 open projects" over a row that was written, open and on the public listing. The
  // poster got no project id and no link, and the site was serving their project.
  const settled = capSettlement([{ id: 'mine', closed: false }], 'mine');
  assert.equal(settled.ownClosed, false);
  assert.equal(settled.unclosed, 1);
});

test('a surplus close that landed is reported as the caller being refused', () => {
  const settled = capSettlement([{ id: 'mine', closed: true }], 'mine');
  assert.equal(settled.ownClosed, true);
  assert.equal(settled.unclosed, 0);
});

test('another owner\'s project failing to close does not refuse the caller\'s post', () => {
  // The two questions are separate: "is my project live?" decides the response, "is this account
  // over cap?" is a log line that the owner's next create or reopen settles. Answering the first
  // with the second is how a soft anti-spam limit turned into a false refusal.
  const settled = capSettlement([{ id: 'older', closed: false }, { id: 'mine', closed: true }], 'mine');
  assert.equal(settled.ownClosed, true);
  assert.equal(settled.unclosed, 1);
});

test('a settlement with nothing to close reports nothing', () => {
  assert.deepEqual(capSettlement([], 'mine'), { ownClosed: false, unclosed: 0 });
});

test('a second post inside the interval is refused and one after it is allowed', () => {
  // Posting is capped by open projects, not by rows, and the cap closes the surplus itself, so
  // without this a loop of posts left one permanent row per request for every later create,
  // reopen and profile deletion to scan.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  const justNow = new Date(asOf - 1_000).toISOString();
  const aWhileBack = new Date(asOf - PROJECT_POST_INTERVAL_MS - 1).toISOString();
  assert.equal(projectPostAllowed(justNow, PROJECT_POST_INTERVAL_MS, asOf), false);
  assert.equal(projectPostAllowed(aWhileBack, PROJECT_POST_INTERVAL_MS, asOf), true);
  // Exactly the interval has passed, so the wait is over.
  assert.equal(projectPostAllowed(new Date(asOf - PROJECT_POST_INTERVAL_MS).toISOString(), PROJECT_POST_INTERVAL_MS, asOf), true);
});

test('a missing or unreadable posting stamp does not refuse the post', () => {
  // An account that has never posted has no row, and a value we cannot parse is not evidence of
  // anything. Refusing on either would turn a storage oddity into an account that cannot post.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  assert.equal(projectPostAllowed('', PROJECT_POST_INTERVAL_MS, asOf), true);
  assert.equal(projectPostAllowed('not a date', PROJECT_POST_INTERVAL_MS, asOf), true);
});

test('a posting stamp from the future does not lock an account out', () => {
  // Nothing an account controls writes this value, but nothing guarantees two Function instances
  // agree on the time either. A stamp dated ahead of now would otherwise bar the account from
  // posting until the clock caught up with it.
  const asOf = Date.parse('2026-09-18T12:00:00.000Z');
  const ahead = new Date(asOf + 5 * 60_000).toISOString();
  assert.equal(projectPostAllowed(ahead, PROJECT_POST_INTERVAL_MS, asOf), true);
});
