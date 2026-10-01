import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from './api';

interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

interface AuthState {
  loading: boolean;
  principal: ClientPrincipal | null;
  user: User | null;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ loading: true, principal: null, user: null, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(null);
  const [user, setUser] = useState<User | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/.auth/me', { credentials: 'same-origin' });
      const payload = (await res.json()) as { clientPrincipal: ClientPrincipal | null };
      const p = payload.clientPrincipal;
      setPrincipal(p);
      if (p) {
        const me = await api.me();
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

  const value = useMemo(() => ({ loading, principal, user, refresh }), [loading, principal, user, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
