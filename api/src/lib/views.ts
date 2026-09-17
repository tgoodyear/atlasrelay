import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, remainingToGoal } from './pledging';
import { Pledge, Project, User } from './store';

// Any '@' at all, not just a dotted domain: alice@localhost is still an address.
const EMAIL_SHAPED = /@/;

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
/**
 * Public shape of a project. Pass live totals when they are already to hand (a single-project
 * read loads the pledges anyway), so that expired reservations are reflected on reads too.
 * Without this the cached creditsPending would keep maxPledge at 0 after a stale pledge expired,
 * and nothing on the read path would ever release it.
 */
export function publicProject(p: Project, live?: { confirmed: number; pending: number }) {
  const confirmed = live ? live.confirmed : p.creditsConfirmed;
  const pending = live ? live.pending : p.creditsPending;
  return {
    ...p,
    creditsConfirmed: confirmed,
    creditsPending: pending,
    ownerName: publicName(p.ownerName, '', p.ownerId),
    funded: confirmed >= p.creditsRequested,
    remaining: remainingToGoal(p.creditsRequested, confirmed),
    // Credits the project can still accept; live pledges reserve their share.
    capacity: capacity(p.creditsRequested, confirmed, pending),
    // Largest single pledge, so no one donor can reserve the whole ceiling.
    maxPledge: maxSinglePledge(p.creditsRequested, confirmed, pending),
    maxCredits: maxCredits(p.creditsRequested),
    // Listing and stats key off confirmed credits alone, so a reservation cannot hide a project.
    open: p.status === 'open' && acceptsMorePledges(p.creditsRequested, confirmed),
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
    // Our server saw RIPE accept the transfer. That is the meaningful assurance; the id is a
    // bonus when the donor's key could also read their transaction list.
    // transferredAt was added later; an older api pledge carries only the transactionUrl, and it
    // was still a transfer our server watched happen. An uncertain transfer is excluded: RIPE
    // never answered, so nobody watched anything and the claim would be false.
    apiTransfer: p.method === 'api' && !p.transferUncertain && Boolean(p.transferredAt || p.transactionUrl),
    hasReference: Boolean(p.transactionId),
    // The transfer was sent but RIPE never answered, so this pledge needs a human to settle it.
    transferUncertain: p.transferUncertain,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function privatePledge(p: Pledge) {
  return { ...publicPledge(p), donorId: p.donorId, transactionUrl: p.transactionUrl, transactionId: p.transactionId, transferredAt: p.transferredAt };
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
