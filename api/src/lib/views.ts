import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, remainingToGoal } from './pledging';
import { Pledge, Project, User } from './store';

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A name safe to show to anonymous visitors. Static Web Apps fills userDetails with the email
 * address for some identity providers, and that value seeds both handle and the initial display
 * name, so anything email-shaped is reduced to its local part before it leaves the API.
 */
export function publicName(displayName: string, handle: string, id: string): string {
  for (const candidate of [displayName, handle]) {
    const value = (candidate || '').trim();
    if (!value) continue;
    if (!EMAIL_SHAPED.test(value)) return value;
    const local = value.split('@')[0].trim();
    if (local) return local;
  }
  return `user-${(id || '').slice(0, 6)}`;
}

/** Public shape of a project. Never includes the owner's email. */
export function publicProject(p: Project) {
  return {
    ...p,
    ownerName: publicName(p.ownerName, '', p.ownerId),
    funded: p.creditsConfirmed >= p.creditsRequested,
    remaining: remainingToGoal(p.creditsRequested, p.creditsConfirmed),
    // Credits the project can still accept; pending pledges reserve their share.
    capacity: capacity(p.creditsRequested, p.creditsConfirmed, p.creditsPending),
    // Largest single pledge, so no one donor can reserve the whole ceiling.
    maxPledge: maxSinglePledge(p.creditsRequested, p.creditsConfirmed, p.creditsPending),
    maxCredits: maxCredits(p.creditsRequested),
    // Listing and stats key off confirmed credits alone, so a pending pledge cannot hide a project.
    open: p.status === 'open' && acceptsMorePledges(p.creditsRequested, p.creditsConfirmed),
  };
}

/** Public shape of a pledge: donor display name, amount, status, message. */
export function publicPledge(p: Pledge) {
  return {
    id: p.id,
    projectId: p.projectId,
    donorName: publicName(p.donorName, '', p.donorId),
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

// Anonymous view of a person. The sign-in handle is deliberately absent: for some identity
// providers it is the user's email address, and this is returned on an unauthenticated endpoint.
export function publicUser(u: User) {
  return {
    id: u.id,
    displayName: publicName(u.displayName, u.handle, u.id),
    affiliation: u.affiliation,
    url: u.url,
    provider: u.provider,
  };
}
