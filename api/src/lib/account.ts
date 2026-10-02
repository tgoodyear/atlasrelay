import { HttpRequest } from '@azure/functions';
import { getPrincipal, Principal, requirePrincipal } from './auth';
import { HttpError } from './http';
import { getUser, User } from './store';

type Lookup = (id: string) => Promise<Pick<User, 'provider'> | null>;

/**
 * The principal, unless its account was created with a different sign-in provider. Google and ORCID
 * ids carry their provider (auth.ts), but GitHub and Microsoft ids are bare, so this is what keeps
 * one of those from acting on the other's account if Static Web Apps ever issued the same id to
 * both (it documents ids as unique per site). Every handler that acts as the signed-in person goes
 * through here, not only the ones that create the profile. An id with no profile row (never made,
 * or deleted) has nothing to compare and is let through, as before.
 */
export async function checkedPrincipal(p: Principal | null, lookup: Lookup = getUser): Promise<Principal | null> {
  if (!p) return null;
  const user = await lookup(p.userId);
  if (user?.provider && user.provider !== p.identityProvider) return null;
  return p;
}

/** The signed-in person, or a 401; a 403 when the account belongs to another provider. */
export async function requireAccount(req: HttpRequest, lookup: Lookup = getUser): Promise<Principal> {
  const p = requirePrincipal(req);
  if (!(await checkedPrincipal(p, lookup))) throw new HttpError(403, 'This account was created with another sign-in provider');
  return p;
}

/** The signed-in person, or null when anonymous or when the account belongs to another provider. */
export async function optionalAccount(req: HttpRequest, lookup: Lookup = getUser): Promise<Principal | null> {
  return checkedPrincipal(getPrincipal(req), lookup);
}
