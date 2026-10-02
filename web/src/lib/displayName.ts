// The display name a new account is offered from its sign-in: the person's name as the provider
// gives it, read from the claims Static Web Apps returns at /.auth/me. The API never sees these
// claims (the header it reads has none), so the app sends the name through the ordinary profile
// update, where the server checks it like any edit. Display names are the person's to change, so
// taking this one from the browser trusts nothing it should not.
//
// GitHub's account name is the GitHub username, which the account already starts with. Google,
// ORCID and Microsoft start with a placeholder or a part of an email address, which this replaces
// with the person's name when the provider has one. An email address, or anything shaped like one,
// is never used, and neither is an ORCID iD.
//
// Nothing in this file may touch the DOM: the tests import it.

export interface Claim {
  typ: string;
  val: string;
}

const NAME = ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];
const GIVEN = ['given_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const FAMILY = ['family_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
const ORCID_ID = /^(https?:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i;
/** The longest display name the API accepts (api/src/functions/me.ts). */
export const DISPLAY_NAME_MAX = 80;

function first(claims: readonly Claim[], types: readonly string[]): string {
  for (const t of types) {
    const c = claims.find((x) => x.typ === t && typeof x.val === 'string' && x.val.trim());
    if (c) return c.val;
  }
  return '';
}

/** A claim value fit to be a display name, or '' when it is not. */
export function usableName(value: string): string {
  // Collapse whitespace and drop anything unprintable.
  const v = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v || v.includes('@') || ORCID_ID.test(v) || v.length > DISPLAY_NAME_MAX) return '';
  return v;
}

/** The person's name from a provider's claims, or '' when there is no usable one. */
export function nameFromClaims(provider: string, claims: readonly Claim[] | undefined): string {
  if (!claims?.length || provider === 'github') return '';
  const name = usableName(first(claims, NAME));
  if (name) return name;
  return usableName(`${first(claims, GIVEN)} ${first(claims, FAMILY)}`);
}

/**
 * Whether to offer the name: only to an account whose profile has never been saved (created and
 * updated at the same moment), and only when it differs from what the account already shows.
 */
export function shouldPrefill(user: { displayName: string; createdAt?: string; updatedAt?: string }, name: string): boolean {
  return Boolean(name) && Boolean(user.createdAt) && user.createdAt === user.updatedAt && user.displayName !== name;
}
