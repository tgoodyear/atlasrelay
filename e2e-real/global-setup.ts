import { writeFileSync } from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';
import { ROLES, credentials, statePath, type Role } from './accounts';
import { signInWithMicrosoft } from './microsoft-login';

// Signs each test account in once, before any test, and saves the browser state the specs start
// from. This runs outside the test runner's steps, traces and reports, so the typed username and
// password appear in none of them. Only the site's own cookies are saved: the Microsoft session
// stays behind, and the specs never visit a Microsoft page.

async function signIn(role: Role, baseURL: string): Promise<void> {
  const account = credentials(role);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await signInWithMicrosoft(page, account, new URL(baseURL).origin);
    const me = await context.request.get('/.auth/me');
    const principal = ((await me.json()) as { clientPrincipal?: { identityProvider?: string } | null }).clientPrincipal;
    if (principal?.identityProvider !== 'aad') throw new Error(`the site does not see a Microsoft sign-in (/.auth/me: HTTP ${me.status()})`);
    const host = new URL(baseURL).hostname;
    const state = await context.storageState();
    state.cookies = state.cookies.filter((c) => c.domain.replace(/^\./, '') === host);
    state.origins = state.origins.filter((o) => new URL(o.origin).hostname === host);
    writeFileSync(statePath(role), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    // The message may quote the page; it never includes what was typed. The stack is dropped.
    throw new Error(`Signing in the ${role} account failed: ${(err as Error).message}`);
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('No baseURL in playwright.config.ts');
  for (const role of ROLES) await signIn(role, baseURL);
  // The workers start after this and inherit the environment: they have no use for the accounts.
  for (const role of ROLES) {
    for (const field of ['USERNAME', 'PASSWORD', 'TOTP']) delete process.env[`E2E_${role.toUpperCase()}_${field}`];
  }
}
