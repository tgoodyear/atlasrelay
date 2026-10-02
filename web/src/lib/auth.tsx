import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from './api';
import { nameFromClaims, shouldPrefill, type Claim } from './displayName';

interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  /** The provider's claims; Static Web Apps returns them for its custom providers only. */
  claims?: Claim[];
}

interface AuthState {
  loading: boolean;
  principal: ClientPrincipal | null;
  user: User | null;
  /** The name this visit took from the sign-in for a new account (lib/displayName.ts), until dismissed. */
  prefilledName: string;
  dismissPrefilledName: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ loading: true, principal: null, user: null, prefilledName: '', dismissPrefilledName: () => {}, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [prefilledName, setPrefilledName] = useState('');
  const dismissPrefilledName = useCallback(() => setPrefilledName(''), []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/.auth/me', { credentials: 'same-origin' });
      const payload = (await res.json()) as { clientPrincipal: ClientPrincipal | null };
      const p = payload.clientPrincipal;
      setPrincipal(p);
      if (p) {
        let me = await api.me();
        // A new account takes the person's name from the sign-in, through the ordinary profile
        // update. Nothing is stored in the browser: the profile itself records that it was saved.
        const name = nameFromClaims(p.identityProvider, p.claims);
        if (shouldPrefill(me.user, name)) {
          try {
            me = await api.updateMe({ displayName: name });
            setPrefilledName(name);
          } catch {
            // The account keeps the name it has; the profile page can change it.
          }
        }
        setUser(me.user);
      } else {
        setUser(null);
      }
    } catch {
      setPrincipal(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ loading, principal, user, prefilledName, dismissPrefilledName, refresh }),
    [loading, principal, user, prefilledName, dismissPrefilledName, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
