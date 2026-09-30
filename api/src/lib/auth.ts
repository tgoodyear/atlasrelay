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
export function getPrincipal(req: HttpRequest, env: Record<string, string | undefined> = process.env): Principal | null {
  if (env.IGNORE_CLIENT_PRINCIPAL === '1') return null;
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Partial<Principal>;
    if (!decoded.userId || !decoded.identityProvider) return null;
    const roles = Array.isArray(decoded.userRoles) ? decoded.userRoles : [];
    if (!roles.includes('authenticated')) return null;
    return {
      identityProvider: decoded.identityProvider,
      userId: decoded.userId,
      // Some providers/emulators send no userDetails; derive a stable placeholder from the id.
      userDetails: (decoded.userDetails ?? '').trim() || `user-${decoded.userId.slice(0, 6)}`,
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
