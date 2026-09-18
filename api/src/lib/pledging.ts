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
