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
// environment's settings (SIGNIN_PROVIDERS) and docs/RUNBOOK.md, "Sign-in registrations", says
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
 * The app settings the custom providers read, as Static Web Apps sees them. infra/signin.bicep
 * writes them: client ids as values, secrets as Key Vault references into the sign-in vault.
 * Microsoft has no secret: OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID is the setting Static Web Apps
 * reserves for signing in with a user-assigned managed identity that the Entra app registration
 * trusts (https://learn.microsoft.com/azure/static-web-apps/authentication-custom, "Use a managed
 * identity instead of a secret").
 */
export const APP_SETTINGS: Record<ProviderId, { clientId: string; clientSecret: string }> = {
  github: { clientId: 'SIGNIN_GITHUB_CLIENT_ID', clientSecret: 'SIGNIN_GITHUB_CLIENT_SECRET' },
  aad: { clientId: 'SIGNIN_MICROSOFT_CLIENT_ID', clientSecret: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID' },
  google: { clientId: 'SIGNIN_GOOGLE_CLIENT_ID', clientSecret: 'SIGNIN_GOOGLE_CLIENT_SECRET' },
  orcid: { clientId: 'SIGNIN_ORCID_CLIENT_ID', clientSecret: 'SIGNIN_ORCID_CLIENT_SECRET' },
};

/**
 * Microsoft's issuer for the site's own registration. "common" takes work, school and personal
 * accounts, as the built-in provider does; the registration must allow all three
 * (docs/RUNBOOK.md).
 */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';
/** What the site asks Microsoft for: sign-in and the person's name and account name, no email. */
export const MICROSOFT_SCOPES = 'openid profile';
export const ORCID_DISCOVERY = 'https://orcid.org/.well-known/openid-configuration';
/**
 * The claim Static Web Apps takes ORCID's account name from: the token's "sub", the ORCID iD, under
 * the name it gives that claim. It renames sub to this type (the claims it lists for a sign-in carry
 * nameidentifier and no sub), and "sub" itself matched nothing on dev (2026-10).
 */
export const ORCID_NAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';

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

/**
 * Whether a build signs in through the site's own registrations rather than the built-in ones. The
 * app passes its own build's value (lib/offered.ts); a value the build refuses reads as built-in.
 */
export function ownRegistrations(value: string | undefined): boolean {
  try {
    return parseSignIn(value).mode === 'custom';
  } catch {
    return false;
  }
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
 * A page on this site to come back to after signing in, or the fallback. Only a page of the app is
 * accepted: anything else could send a person who just signed in to another site, or into a
 * sign-out or another sign-in. The value is resolved the way a browser would and rebuilt from its
 * parts, so dot segments and encoded slashes cannot turn it into //host.
 */
export function safeReturnPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, 'https://return.invalid');
  } catch {
    return fallback;
  }
  const path = url.pathname;
  if (url.origin !== 'https://return.invalid' || path.startsWith('//') || /%2f|%5c/i.test(path)) return fallback;
  // Not the sign-in page itself either: signing in from it would land back on it, which redirects again.
  if (/^\/(\.auth|api|login|logout|signin)(\/|$)/i.test(path)) return fallback;
  return path + url.search + url.hash;
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
/** Where /logout leads in a build with the site's own registrations (see signInConfig). */
export const SIGN_OUT_CUSTOM = '/.auth/logout/complete';

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
  let routes = [...rest.slice(0, at), ...signInRoutes, ...rest.slice(at)] as T['routes'];
  if (signIn.mode === 'built-in') return { ...base, routes };
  // Signing out with the site's own Microsoft registration sends the browser to Microsoft's sign-out
  // page, which ends the person's whole Microsoft session in that browser and, on dev in 2026-10,
  // never came back, so the site's own cookie was never cleared and the person stayed signed in.
  // /logout goes straight to the step that clears the site's cookie and returns home, for every
  // provider. It leaves the provider's own session alone, as the built-in providers do.
  routes = routes.map((r) => (r.route === '/logout' ? { ...r, redirect: SIGN_OUT_CUSTOM } : r)) as T['routes'];
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
      // Static Web Apps asks Microsoft for "openid profile email" by default. The site never uses
      // the email address, and the consent screen lists it ("View your email address"), so it asks
      // for openid and profile only; profile gives the account name (preferred_username) and name.
      // select_account: after signing out of the site, Microsoft's own session would otherwise sign
      // the same account straight back in, with no way to pick another.
      login: {
        loginParameters: [`scope=${MICROSOFT_SCOPES}`, 'prompt=select_account'],
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
          // ORCID's token endpoint takes only client_secret_post. "ClientSecretPost" is the one value
          // App Service authentication (which Static Web Apps' custom providers mirror) defines for
          // this field; stating it keeps the exchange from depending on a default.
          clientCredential: { method: 'ClientSecretPost', clientSecretSettingName: APP_SETTINGS.orcid.clientSecret },
          openIdConnectConfiguration: { wellKnownOpenIdConfiguration: ORCID_DISCOVERY },
        },
        login: {
          // The account name (userDetails) is the ORCID iD, the "sub" claim. Static Web Apps refuses
          // a sign-in with no account name ("403: We need an email address or a handle from your
          // login service", seen on dev in 2026-10 with the default claim), and ORCID's token has no
          // email or preferred_username; its "name" is there only when the record makes it public.
          // The iD is public by design. It never becomes the public display name (api views.ts);
          // the app offers the person's name from the token instead (web lib/displayName.ts).
          nameClaimType: ORCID_NAME_CLAIM,
          // The only scope ORCID's OpenID Connect discovery lists.
          scopes: ['openid'],
          loginParameterNames: [],
        },
      },
    };
  }
  return providers;
}
