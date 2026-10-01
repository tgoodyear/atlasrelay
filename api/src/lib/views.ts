import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, remainingToGoal } from './pledging';
import { Pledge, Project, User, creditedAmount, donorMayCancelApiPledge } from './store';

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

/**
 * Whether anyone may see a project: every project except one an operator took down
 * (moderationClosed, see docs/RUNBOOK.md). The sitemap, the listing and the server-rendered project
 * page apply it as is, so a page the sitemap leaves out answers 404. GET /api/projects/{id} applies
 * it to everyone except the project's owner, who can still see what was taken down and settle its
 * pledges; for the owner alone, the app shows the project over the 404 page the server sent.
 */
export function isPublicProject(p: Pick<Project, 'moderationClosed'>): boolean {
  return !p.moderationClosed;
}

/**
 * Public shape of a project. Pass live totals when they are already to hand (a single-project
 * read loads the pledges anyway), so that expired reservations are reflected on reads too.
 * Without this the cached creditsPending would keep maxPledge at 0 after a stale pledge expired,
 * and nothing on the read path would ever release it.
 */
export function publicProject(p: Project, live?: { confirmed: number; pending: number }) {
  const confirmed = live ? live.confirmed : p.creditsConfirmed;
  const pending = live ? live.pending : p.creditsPending;
  // This function spreads the row, so anything internal has to be removed by name rather than
  // merely left unmentioned. A field added to Project is published by default here, which is why
  // both this list and its tests exist.
  //   ownerId          the identity-provider account id. The profile page tells people the account
  //                    link is internal and that retained records show only their display name, so
  //                    it cannot appear on an anonymous endpoint. Ownership is decided server-side
  //                    and returned as viewer.isOwner, so nothing out here needs it.
  //   moderationClosed an operator's note about the row, not something the project says of itself.
  //   etag             the storage row version, used for conditional writes.
  //   totalsCheckedAt  maintenance bookkeeping for the listing's refresh rotation.
  //   totalsDirty      maintenance bookkeeping: totals that could not be written and need redoing.
  //   storedAt         the storage row's own write time, used only by profile deletion.
  const {
    ownerId: _ownerId,
    moderationClosed: _moderationClosed,
    etag: _etag,
    totalsCheckedAt: _totalsCheckedAt,
    totalsDirty: _totalsDirty,
    storedAt: _storedAt,
    ...rest
  } = p;
  return {
    ...rest,
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
    // The owner has posted a write-up. A plain Boolean coercion and nothing else, deliberately:
    // this function runs on the transfer path, where pledges.ts returns publicProject(updated)
    // after the credits have already moved, so anything here that can throw turns a completed
    // transfer into a 500 in the donor's browser. That is the failure the Atlas timeouts were
    // retuned to prevent, and it would be careless to reintroduce it over a badge. No Date.parse,
    // no new URL(), no truncation: the row is whatever storage holds and this stays total over it.
    hasResults: Boolean(p.resultsPostedAt),
  };
}

/** Public shape of a pledge: donor display name, amount, status, message. */
export function publicPledge(p: Pledge) {
  return {
    id: p.id,
    projectId: p.projectId,
    // A donor who asked not to be named is not named, and the fallback is a constant rather than
    // publicName's user-abc123 form: that is derived from the account id, so it is stable across
    // every pledge the same person makes and would let anyone match up an anonymous donor's
    // pledges across projects. Anonymous has to mean anonymous, not pseudonymous.
    donorName: p.anonymous ? 'Anonymous' : publicName(p.donorName, '', p.donorId),
    // Published so the listing can say the name is withheld by choice rather than missing.
    anonymous: p.anonymous,
    // What the pledge counts for: what arrived, when the owner checked it against their RIPE Atlas
    // log, otherwise what was pledged. pledgedAmount keeps the original so a difference can be shown.
    amount: creditedAmount(p),
    pledgedAmount: p.amount,
    // The API itself read the amount from the owner's RIPE Atlas transaction log when the pledge was
    // confirmed. Not a statement about who sent it: RIPE's rows do not name the sender.
    amountVerified: p.amountVerified,
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

/**
 * What the project owner and the donor themselves see. The owner confirms manual transfers
 * themselves, and may need to reconcile any pledge against their own RIPE transaction log, which
 * names the sending account, so the name is restored here even when the donor chose to be
 * anonymous publicly. (An API transfer is confirmed by the server once it watches RIPE accept it.) `anonymous` stays set,
 * so the dashboard can tell them the name is not public and they should not repeat it.
 *
 * Only ever reached by those two: the pledges route gives every row to the owner and gives a donor
 * only their own rows, and the dashboard reads a donor's own pledges.
 */
export function privatePledge(p: Pledge) {
  return {
    ...publicPledge(p),
    donorName: publicName(p.donorName, '', p.donorId),
    donorId: p.donorId,
    transactionUrl: p.transactionUrl,
    transactionId: p.transactionId,
    transferredAt: p.transferredAt,
    // Whether this pledge's own donor may withdraw it. Derived here from the same predicate the update
    // handler enforces, because the page cannot work it out for itself: the rule turns on inFlight and
    // inFlightSince, and neither is published. Without it the project page offered a Cancel button that
    // always came back 409, which is how the donor learned the rule.
    donorMayCancel: p.method === 'manual' || donorMayCancelApiPledge(p),
  };
}

export function privateUser(u: User) {
  // Spreads the row, so the storage version has to be dropped by name like everywhere else.
  const { etag: _etag, ...rest } = u;
  return { ...rest, hasAtlasEmail: Boolean(u.atlasEmail) };
}

// Anonymous view of a person. The sign-in handle is deliberately absent: for some identity
// providers it is the user's email address, and this is returned on an unauthenticated endpoint.
export function publicUser(u: User) {
  return {
    // No id, for the same reason publicProject drops ownerId: it is the account identifier, the
    // privacy copy calls it internal, and nothing in the UI reads it.
    displayName: publicName(u.displayName, u.handle, u.id),
    affiliation: u.affiliation,
    url: u.url,
    provider: u.provider,
  };
}
