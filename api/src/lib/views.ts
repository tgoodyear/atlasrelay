import { capacity, maxCredits, remainingToGoal } from './pledging';
import { Pledge, Project, User } from './store';

/** Public shape of a project. Never includes the owner's email. */
export function publicProject(p: Project) {
  return {
    ...p,
    funded: p.creditsConfirmed >= p.creditsRequested,
    remaining: remainingToGoal(p.creditsRequested, p.creditsConfirmed),
    // Credits the project can still accept (it keeps accepting up to 100× its request); pending pledges count.
    capacity: capacity(p.creditsRequested, p.creditsConfirmed, p.creditsPending),
    maxCredits: maxCredits(p.creditsRequested),
  };
}

/** Public shape of a pledge: donor display name, amount, status, message. */
export function publicPledge(p: Pledge) {
  return {
    id: p.id,
    projectId: p.projectId,
    donorName: p.donorName,
    amount: p.amount,
    method: p.method,
    status: p.status,
    message: p.message,
    hasProof: Boolean(p.transactionUrl),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function privatePledge(p: Pledge) {
  return { ...publicPledge(p), donorId: p.donorId, transactionUrl: p.transactionUrl };
}

export function privateUser(u: User) {
  return { ...u, hasAtlasEmail: Boolean(u.atlasEmail) };
}

export function publicUser(u: User) {
  return { id: u.id, displayName: u.displayName, affiliation: u.affiliation, url: u.url, handle: u.handle, provider: u.provider };
}
