/** Projects keep accepting credits until they have received this many times their request. */
export const OVERFUND_MULTIPLIER = 100;

/** Upper bound on total confirmed credits for a project. */
export function maxCredits(creditsRequested: number): number {
  return creditsRequested * OVERFUND_MULTIPLIER;
}

/**
 * Largest pledge a project will accept right now. Pending pledges (pledged/sent) reserve
 * capacity so several manual pledges cannot each claim the whole ceiling; cancelling one
 * releases its share because totals are recomputed from the pledge rows.
 */
export function capacity(creditsRequested: number, creditsConfirmed: number, creditsPending = 0): number {
  return Math.max(0, maxCredits(creditsRequested) - creditsConfirmed - creditsPending);
}

/** True when confirming `amount` more credits would push the project past its ceiling. */
export function exceedsCeiling(creditsRequested: number, creditsConfirmed: number, amount: number): boolean {
  return creditsConfirmed + amount > maxCredits(creditsRequested);
}

/** Credits still needed to reach the stated goal (never negative). */
export function remainingToGoal(creditsRequested: number, creditsConfirmed: number): number {
  return Math.max(0, creditsRequested - creditsConfirmed);
}
