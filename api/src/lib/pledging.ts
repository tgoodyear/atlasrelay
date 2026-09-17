/** Projects keep accepting credits until they have received this many times their request. */
export const OVERFUND_MULTIPLIER = 100;

/** Upper bound on total confirmed credits for a project. */
export function maxCredits(creditsRequested: number): number {
  return creditsRequested * OVERFUND_MULTIPLIER;
}

/** Largest pledge a project will accept right now. */
export function capacity(creditsRequested: number, creditsConfirmed: number): number {
  return Math.max(0, maxCredits(creditsRequested) - creditsConfirmed);
}

/** Credits still needed to reach the stated goal (never negative). */
export function remainingToGoal(creditsRequested: number, creditsConfirmed: number): number {
  return Math.max(0, creditsRequested - creditsConfirmed);
}
