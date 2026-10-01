import { offeredProviders } from './signin';

/** The sign-in providers this build offers. vite.config.ts checks VITE_SIGNIN_PROVIDERS before it builds. */
export const OFFERED = offeredProviders(import.meta.env.VITE_SIGNIN_PROVIDERS);
