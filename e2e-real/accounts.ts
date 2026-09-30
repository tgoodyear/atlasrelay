import { join } from 'node:path';

// The two test accounts. They live in the test tenant; their usernames and passwords come from
// Key Vault through run.mjs (or E2E_* variables on a local run), and never reach a spec.
export const ROLES = ['researcher', 'donor'] as const;
export type Role = (typeof ROLES)[number];

export interface Credentials {
  username: string;
  password: string;
  /** Base32 TOTP seed; empty when the account has no authenticator. */
  totp: string;
}

/** Read by global-setup.ts only. */
export function credentials(role: Role): Credentials {
  const prefix = `E2E_${role.toUpperCase()}_`;
  const username = process.env[`${prefix}USERNAME`] ?? '';
  const password = process.env[`${prefix}PASSWORD`] ?? '';
  if (!username || !password) throw new Error(`No ${role} account: set ${prefix}USERNAME and ${prefix}PASSWORD, or run through run.mjs`);
  return { username, password, totp: process.env[`${prefix}TOTP`] ?? '' };
}

/** Where global-setup.ts saves each account's signed-in browser state (outside the results). */
export function statePath(role: Role): string {
  const dir = process.env.E2E_STATE_DIR;
  if (!dir) throw new Error('E2E_STATE_DIR is unset; run the suite through run.mjs');
  return join(dir, `${role}.json`);
}

/** The RIPE NCC Access email the researcher's profile carries. A reserved domain: nothing is sent to it. */
export const RESEARCHER_ATLAS_EMAIL = process.env.E2E_RESEARCHER_ATLAS_EMAIL || 'atlasrelay-e2e-researcher@example.org';
