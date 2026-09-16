import { HttpRequest } from '@azure/functions';
import { HttpError } from './http';

export interface Principal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

/** Decode the client principal that Static Web Apps injects. Returns null when anonymous. */
export function getPrincipal(req: HttpRequest): Principal | null {
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
