import { offeredProviders, ownRegistrations } from './signin';

/** The sign-in providers this build offers. vite.config.ts checks VITE_SIGNIN_PROVIDERS before it builds. */
export const OFFERED = offeredProviders(import.meta.env.VITE_SIGNIN_PROVIDERS);
/** Whether this build signs in through the site's own registrations (lib/signin.ts) rather than the built-in ones. */
export const OWN_REGISTRATIONS = ownRegistrations(import.meta.env.VITE_SIGNIN_PROVIDERS);
