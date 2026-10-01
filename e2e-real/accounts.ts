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

/** One side of the real transfers: a RIPE Atlas API key and the RIPE NCC Access email of its account. */
export interface RipeSide {
  key: string;
  account: string;
}

/**
 * The two RIPE Atlas accounts the real-transfer tests move credits between, from run.mjs (the
 * vault secrets ripe-donor-key, ripe-donor-account, ripe-recipient-key and ripe-recipient-account,
 * written by scripts/set-ripe-keys.sh), or null when the job names none. The donor account holds
 * the credits; the recipient account is the researcher's, and sends them back after each run.
 */
export function ripeAccounts(): { donor: RipeSide; recipient: RipeSide } | null {
  const get = (name: string) => process.env[`E2E_RIPE_${name}`] ?? '';
  const donor = { key: get('DONOR_KEY'), account: get('DONOR_ACCOUNT') };
  const recipient = { key: get('RECIPIENT_KEY'), account: get('RECIPIENT_ACCOUNT') };
  if (![donor.key, donor.account, recipient.key, recipient.account].some(Boolean)) return null;
  if (![donor.key, donor.account, recipient.key, recipient.account].every(Boolean)) {
    throw new Error('Set all four of E2E_RIPE_DONOR_KEY, E2E_RIPE_DONOR_ACCOUNT, E2E_RIPE_RECIPIENT_KEY and E2E_RIPE_RECIPIENT_ACCOUNT, or none');
  }
  if (donor.account.toLowerCase() === recipient.account.toLowerCase() || donor.key === recipient.key) {
    throw new Error('The donor and the recipient must be two different RIPE Atlas accounts');
  }
  return { donor, recipient };
}

/** Credits each real-transfer run sends and returns: E2E_RIPE_TRANSFER_CREDITS, 100 by default. */
export function ripeTransferCredits(): number {
  const raw = process.env.E2E_RIPE_TRANSFER_CREDITS || '100';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`E2E_RIPE_TRANSFER_CREDITS must be a whole number of credits, not ${raw}`);
  return n;
}
