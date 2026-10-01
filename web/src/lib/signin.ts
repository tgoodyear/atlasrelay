// Sign-in providers, shared by the build (vite.config.ts writes staticwebapp.config.json with
// them) and the running app (the sign-in buttons). Nothing in this file may touch the DOM or Node
// APIs.
//
// Static Web Apps offers two kinds of sign-in, and a site has one or the other:
//
//   built-in  GitHub and Microsoft through Azure's own app registrations. Nothing to configure and
//             no secret. This is what the site uses unless the build says otherwise.
//   custom    The site's own app registrations, named in staticwebapp.config.json under
//             auth.identityProviders, with client ids and secrets in the site's app settings.
//             Google and ORCID need this. Configuring any custom provider turns off every
//             built-in one, so GitHub and Microsoft then need registrations of their own as well.
//
// The build reads VITE_SIGNIN_PROVIDERS. Empty (the default) builds the built-in site. Otherwise it
// lists the custom providers, and must name github and aad, so that turning on Google or ORCID
// never takes GitHub or Microsoft sign-in away. scripts/provision.sh works the value out from the
// environment's settings (SIGNIN_PROVIDERS) and docs/RUNBOOK.md, "Google and ORCID sign-in", says
// how it reaches a build.

export type ProviderId = 'github' | 'aad' | 'google' | 'orcid';

export interface Provider {
  /** The name in /.auth/login/<id> and in the client principal's identityProvider. */
  id: ProviderId;
  /** The name shown to people. */
  label: string;
  /** The short route that starts this provider's sign-in, e.g. /login/orcid. */
  shortcut: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'github', label: 'GitHub', shortcut: '/login' },
  { id: 'aad', label: 'Microsoft', shortcut: '/login/microsoft' },
  { id: 'google', label: 'Google', shortcut: '/login/google' },
  { id: 'orcid', label: 'ORCID', shortcut: '/login/orcid' },
];

/** Every custom build has these, because a custom provider turns the built-in ones off. */
const REQUIRED: readonly ProviderId[] = ['github', 'aad'];

/**
 * Providers the site never offers. Static Web Apps answers some of these on its own (it still sent
 * /.auth/login/google and /.auth/login/facebook on to the provider in 2026-10), so each gets a 404
 * route. Google and ORCID join the list whenever the build does not turn them on.
 */
const NEVER: readonly string[] = ['facebook', 'twitter', 'apple'];

/**
 * The app settings the custom providers read, as Static Web Apps sees them. infra/app.bicep writes
 * them from the environment's settings (ATLASRELAY_<PROVIDER>_CLIENT_ID and _CLIENT_SECRET).
 */
export const APP_SETTINGS: Record<ProviderId, { clientId: string; clientSecret: string }> = {
  github: { clientId: 'SIGNIN_GITHUB_CLIENT_ID', clientSecret: 'SIGNIN_GITHUB_CLIENT_SECRET' },
  aad: { clientId: 'SIGNIN_MICROSOFT_CLIENT_ID', clientSecret: 'SIGNIN_MICROSOFT_CLIENT_SECRET' },
  google: { clientId: 'SIGNIN_GOOGLE_CLIENT_ID', clientSecret: 'SIGNIN_GOOGLE_CLIENT_SECRET' },
  orcid: { clientId: 'SIGNIN_ORCID_CLIENT_ID', clientSecret: 'SIGNIN_ORCID_CLIENT_SECRET' },
};

/**
 * Microsoft's issuer for the site's own registration. "common" takes work, school and personal
 * accounts, as the built-in provider does; the registration must allow all three
 * (docs/RUNBOOK.md).
 */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';
export const ORCID_DISCOVERY = 'https://orcid.org/.well-known/openid-configuration';

export type SignIn = { mode: 'built-in'; providers: ProviderId[] } | { mode: 'custom'; providers: ProviderId[] };

/** Reads VITE_SIGNIN_PROVIDERS. Throws on a value the build must not ship. */
export function parseSignIn(value: string | undefined): SignIn {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return { mode: 'built-in', providers: [...REQUIRED] };
  const known = new Set<string>(PROVIDERS.map((p) => p.id));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`VITE_SIGNIN_PROVIDERS: unknown provider ${unknown.join(', ')}; expected some of ${[...known].join(', ')}`);
  const missing = REQUIRED.filter((r) => !names.includes(r));
  if (missing.length) {
    throw new Error(
      `VITE_SIGNIN_PROVIDERS: a custom sign-in build must include ${missing.join(' and ')}: ` +
        'any custom provider turns the built-in GitHub and Microsoft sign-in off',
    );
  }
  return { mode: 'custom', providers: PROVIDERS.map((p) => p.id).filter((id) => names.includes(id)) };
}

/** The providers a build offers, in the order the buttons show them. The app passes its own build's value (lib/offered.ts). */
export function offeredProviders(value: string | undefined): Provider[] {
  let on: ProviderId[];
  try {
    on = parseSignIn(value).providers;
  } catch {
    // The build refuses such a value, so this only happens in a test; fall back to the built-ins.
    on = [...REQUIRED];
  }
  return PROVIDERS.filter((p) => on.includes(p.id));
}

/** "GitHub or Microsoft", "GitHub, Microsoft, Google or ORCID": the providers, for a sentence. */
export function providerList(providers: readonly Provider[]): string {
  const names = providers.map((p) => p.label);
  return names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The name to show for a provider id; anything unknown reads as "another provider". */
export function providerLabel(id: string | undefined): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? 'another provider';
}

/**
 * A path on this site to come back to after signing in, or the fallback. Only a local path is
 * accepted: anything else could send a person who just signed in to another site.
 */
export function safeReturnPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  if (/[\x00-\x1f\x7f]/.test(value)) return fallback;
  return value;
}

export function loginUrl(provider: ProviderId, returnTo: string): string {
  return `/.auth/login/${provider}?post_login_redirect_uri=${encodeURIComponent(safeReturnPath(returnTo))}`;
}

// ---------- staticwebapp.config.json ----------

interface Route {
  route: string;
  redirect?: string;
  statusCode?: number;
}

interface SwaConfig {
  routes: Route[];
}

const LOGIN_ROUTE = /^\/\.auth\/login\/[a-z]+$/;

/**
 * staticwebapp.config.json for a build: the committed file (web/public), with the sign-in routes
 * and, in a custom build, the auth section. The committed file holds the built-in site's routes;
 * this replaces every /.auth/login/<provider> block and every /login shortcut with the ones the
 * build's providers need, keeping their place at the head of the route list.
 */
export function signInConfig<T extends SwaConfig>(base: T, signIn: SignIn): T {
  if ((base as { auth?: unknown }).auth !== undefined) throw new Error('staticwebapp.config.json: the auth section is written by the build; remove it from web/public');
  const offered = new Set<string>(signIn.providers);
  const blocked = [...NEVER, ...PROVIDERS.map((p) => p.id).filter((id) => !offered.has(id))];
  const shortcuts = new Set(PROVIDERS.map((p) => p.shortcut));
  const first = base.routes.findIndex((r) => LOGIN_ROUTE.test(r.route) || shortcuts.has(r.route));
  const rest = base.routes.filter((r) => !LOGIN_ROUTE.test(r.route) && !shortcuts.has(r.route));
  const signInRoutes = [
    ...blocked.map((p) => ({ route: `/.auth/login/${p}`, statusCode: 404 })),
    ...PROVIDERS.filter((p) => offered.has(p.id)).map((p) => ({
      route: p.shortcut,
      redirect: `/.auth/login/${p.id}?post_login_redirect_uri=/dashboard`,
      statusCode: 302,
    })),
  ];
  const at = first < 0 ? 0 : first;
  const routes = [...rest.slice(0, at), ...signInRoutes, ...rest.slice(at)] as T['routes'];
  if (signIn.mode === 'built-in') return { ...base, routes };
  return { ...base, routes, auth: { identityProviders: identityProviders(signIn.providers) } };
}

function identityProviders(on: ProviderId[]) {
  const providers: Record<string, unknown> = {
    github: {
      registration: { clientIdSettingName: APP_SETTINGS.github.clientId, clientSecretSettingName: APP_SETTINGS.github.clientSecret },
    },
    azureActiveDirectory: {
      registration: {
        openIdIssuer: MICROSOFT_ISSUER,
        clientIdSettingName: APP_SETTINGS.aad.clientId,
        clientSecretSettingName: APP_SETTINGS.aad.clientSecret,
      },
    },
  };
  if (on.includes('google')) {
    providers.google = {
      registration: { clientIdSettingName: APP_SETTINGS.google.clientId, clientSecretSettingName: APP_SETTINGS.google.clientSecret },
    };
  }
  if (on.includes('orcid')) {
    providers.customOpenIdConnectProviders = {
      orcid: {
        registration: {
          clientIdSettingName: APP_SETTINGS.orcid.clientId,
          clientCredential: { clientSecretSettingName: APP_SETTINGS.orcid.clientSecret },
          openIdConnectConfiguration: { wellKnownOpenIdConfiguration: ORCID_DISCOVERY },
        },
        login: {
          // ORCID puts the iD in "sub". Using "name" here keeps the iD out of the account name the
          // site stores and shows; people with no public name get a placeholder (api auth.ts).
          nameClaimType: 'name',
          // The only scope ORCID's OpenID Connect discovery lists.
          scopes: ['openid'],
          loginParameterNames: [],
        },
      },
    };
  }
  return providers;
}
