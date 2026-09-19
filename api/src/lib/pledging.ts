/** Projects keep accepting credits until they have received this many times their request. */
export const OVERFUND_MULTIPLIER = 100;

/**
 * Open projects one account may hold at once. Posting is free and anonymous enough that without
 * a cap one account could fill the front page, and every project exposes its owner's contact
 * address to anyone who starts a pledge. Closing a funded project frees a slot, so an honest
 * researcher running several studies is never blocked for long.
 */
export const MAX_OPEN_PROJECTS_PER_USER = 3;

/**
 * How long an account must wait between posting projects.
 *
 * The cap above limits open projects, not rows, and nothing prunes a closed one. The cap's own
 * settlement closes the surplus for the poster, so a loop of POSTs needs no close step: each
 * request leaves a permanent row, and every later create, reopen and profile deletion reads the
 * whole projects partition to answer "how many open projects does this account have".
 *
 * A minute is chosen against what the two sides cost. A project description is written by a
 * person, so two posts from one account inside a minute is a machine; an honest researcher filling
 * their three slots in one sitting waits two minutes in total. It bounds the rate at which one
 * account can grow that scan. It does not bound the total -- only pruning closed rows does that,
 * and nothing here prunes.
 */
export const PROJECT_POST_INTERVAL_MS = 60_000;

/**
 * Whether an account may post again, given when it last posted.
 *
 * Separated from the storage call so the rule can be tested, and because both edges matter. An
 * absent or unparseable stamp allows the post: the limiter is anti-abuse, and a value we cannot
 * read is not evidence of anything, so refusing on it would lock an account out over a storage
 * oddity. A stamp in the future is the same case -- clocks across Function instances are not
 * guaranteed to agree, and a stamp we cannot have written yet must not be able to bar an account
 * until it passes.
 */
export function projectPostAllowed(lastPostedAt: string, minIntervalMs: number, asOf: number = Date.now()): boolean {
  const last = Date.parse(lastPostedAt);
  if (!Number.isFinite(last)) return true;
  const age = asOf - last;
  return age < 0 || age >= minIntervalMs;
}

/**
 * The open projects an owner has to give up to come back under the cap: everything after the
 * first `max` in id order.
 *
 * Ids are time-prefixed, so oldest-first means every racing request picks the same set without
 * coordinating, and what survives is what was already there. Copies before sorting rather than
 * sorting in place, because this answers a question about the caller's list and must not rewrite
 * it.
 */
export function surplusOpenProjects<T extends { id: string }>(open: T[], max: number): T[] {
  if (open.length <= max) return [];
  return [...open].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(max);
}

/** One surplus project and whether storage now reports it closed. */
export interface SurplusClose {
  id: string;
  closed: boolean;
}

/**
 * What a cap settlement achieved, read from the rows it observed rather than the set it meant to
 * close.
 *
 * The opposite shipped: the settlement returned `surplus.some(x => x.id === ownId)`, which says
 * "this project was selected for closing", and the create handler read it as "this project is
 * closed". Closing a surplus row is best effort by design -- it runs after the row is durable, and
 * a storage hiccup there must not fail a request whose project exists -- so those two are the same
 * value only when every write succeeded, which is precisely what the best-effort catch gives up.
 * When the caller's own close failed, the caller was told their project was refused while it was
 * written, open and on the public listing.
 *
 * Two separate questions, because the answers differ: `ownClosed` is "is my project live?", which
 * decides the response, and `unclosed` is "is this account still over cap?", which is a log line
 * and settles itself on the owner's next create or reopen.
 */
export function capSettlement(closes: SurplusClose[], ownId: string): { ownClosed: boolean; unclosed: number } {
  return {
    ownClosed: closes.some((c) => c.id === ownId && c.closed),
    unclosed: closes.filter((c) => !c.closed).length,
  };
}

/**
 * A pending pledge stops reserving capacity after this long. Reservations are how a donor is
 * given time to make a manual transfer, but without an expiry one abandoned pledge would hold a
 * project's capacity for ever, so stale ones fall away on their own.
 */
export const PENDING_RESERVATION_DAYS = 14;

/** Upper bound on total confirmed credits for a project. */
export function maxCredits(creditsRequested: number): number {
  return creditsRequested * OVERFUND_MULTIPLIER;
}

/** Credits still needed to reach the stated goal (never negative). */
export function remainingToGoal(creditsRequested: number, creditsConfirmed: number): number {
  return Math.max(0, creditsRequested - creditsConfirmed);
}

/**
 * Credits a project can still accept. Pending pledges reserve capacity so that several donors do
 * not each transfer the last slice, but only confirmed credits decide whether a project is still
 * listed (see acceptsMorePledges), so a pending pledge cannot hide a project from the site.
 */
export function capacity(creditsRequested: number, creditsConfirmed: number, creditsPending = 0): number {
  return Math.max(0, maxCredits(creditsRequested) - creditsConfirmed - creditsPending);
}

/** Whether the project is still short of its ceiling on confirmed credits alone. */
export function acceptsMorePledges(creditsRequested: number, creditsConfirmed: number): boolean {
  return creditsConfirmed < maxCredits(creditsRequested);
}

/**
 * Largest single pledge a project accepts. Capped at what is still needed to reach the goal, or
 * at one goal's worth once the goal is met, so that no single pledge can reserve the whole 100x
 * ceiling and lock everyone else out.
 */
export function maxSinglePledge(creditsRequested: number, creditsConfirmed: number, creditsPending = 0): number {
  const remaining = remainingToGoal(creditsRequested, creditsConfirmed);
  const perPledgeLimit = remaining > 0 ? remaining : creditsRequested;
  return Math.min(perPledgeLimit, capacity(creditsRequested, creditsConfirmed, creditsPending));
}

/** The figures on the home page. Derived only from projects, so it is a pure function of them. */
export interface SiteStats {
  projects: number;
  openProjects: number;
  creditsRequested: number;
  creditsTransferred: number;
  fundedProjects: number;
  projectsWithResults: number;
}

/**
 * Compute the home-page figures. Separated from the handler so the definitions can be tested:
 * "open" has to mean the same thing here as in the project listing, and "credits requested" is
 * what open projects still need rather than what they originally asked for, which are exactly the
 * kinds of thing that drift apart silently.
 */
export function siteStats(
  projects: { status: string; creditsRequested: number; creditsConfirmed: number; resultsPostedAt: string }[],
): SiteStats {
  const open = projects.filter((p) => p.status === 'open' && acceptsMorePledges(p.creditsRequested, p.creditsConfirmed));
  return {
    projects: projects.length,
    openProjects: open.length,
    creditsRequested: open.reduce((s, p) => s + remainingToGoal(p.creditsRequested, p.creditsConfirmed), 0),
    creditsTransferred: projects.reduce((s, p) => s + p.creditsConfirmed, 0),
    fundedProjects: projects.filter((p) => p.creditsConfirmed >= p.creditsRequested).length,
    // Counted off the stamp rather than off the write-up text, so a researcher who reports and
    // later trims their summary to nothing still counts as having reported. Counted over every
    // project rather than only funded ones, because a project can be worth reporting on after
    // partial funding and the home page is not the place to argue about the threshold. Sitting
    // next to fundedProjects is what gives the figure its meaning: the gap between the two is the
    // number this site exists to shrink, and it reads 0 of 0 today, which is honest.
    projectsWithResults: projects.filter((p) => Boolean(p.resultsPostedAt)).length,
  };
}
