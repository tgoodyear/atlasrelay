import { HttpRequest } from '@azure/functions';
import { HttpError } from './http';

export interface Principal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

/**
 * Decode the client principal that Static Web Apps injects. Returns null when anonymous.
 *
 * The header is trusted because only Static Web Apps can reach the API: linking the Function App
 * to the site puts an identity provider in front of it that refuses every request the site did not
 * send. Until that link exists the Function App answers anyone who knows its hostname, so Bicep
 * sets IGNORE_CLIENT_PRINCIPAL=1 on an unlinked app and every request is anonymous. Public routes
 * still work, which is what the cutover checks before linking (docs/RUNBOOK.md).
 */
/**
 * The providers the site offers (web/src/lib/signin.ts). A principal from any other provider is
 * treated as anonymous, so a provider Static Web Apps turns on by itself can never create accounts.
 */
export const PROVIDERS = ['github', 'aad', 'google', 'orcid'] as const;

/**
 * Providers whose account ids are stored with the provider's name in front ("orcid:<id>").
 * Static Web Apps documents userId as unique per site, so two providers should never hand over the
 * same id; the prefix makes sure that, even if one did, an ORCID or Google sign-in could never
 * reach an account made with another provider. GitHub and Microsoft accounts keep the bare ids they
 * were created with, so existing projects and pledges stay theirs.
 */
const PREFIXED = new Set<string>(['google', 'orcid']);

export function accountId(provider: string, userId: string): string {
  return PREFIXED.has(provider) ? `${provider}:${userId}` : userId;
}

export function getPrincipal(req: HttpRequest, env: Record<string, string | undefined> = process.env): Principal | null {
  if (env.IGNORE_CLIENT_PRINCIPAL === '1') return null;
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Partial<Principal>;
    if (typeof decoded.userId !== 'string' || typeof decoded.identityProvider !== 'string' || !decoded.userId) return null;
    const provider = decoded.identityProvider.toLowerCase();
    if (!(PROVIDERS as readonly string[]).includes(provider)) return null;
    // Table Storage refuses these characters in a key, and no provider's id contains them.
    if (/[\\/#?\x00-\x1f\x7f]/.test(decoded.userId)) return null;
    const roles = Array.isArray(decoded.userRoles) ? decoded.userRoles : [];
    if (!roles.includes('authenticated')) return null;
    return {
      identityProvider: provider,
      userId: accountId(provider, decoded.userId),
      // Some providers send no userDetails (ORCID, for someone whose name is not public); derive a
      // stable placeholder from the id.
      userDetails: (typeof decoded.userDetails === 'string' ? decoded.userDetails : '').trim() || `user-${decoded.userId.slice(0, 6)}`,
      userRoles: roles,
    };
  } catch {
    return null;
  }
}

export function requirePrincipal(req: HttpRequest): Principal {
  const p = getPrincipal(req);
  if (!p) throw new HttpError(401, 'Sign in required');
  return p;
}
