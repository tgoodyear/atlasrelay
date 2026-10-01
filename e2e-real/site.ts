import { request as playwrightRequest, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { statePath, type Role } from './accounts';

// What the specs do with the signed-in test accounts outside the page steps of web/e2e/ui.ts.

/**
 * Deletes the account's profile through the API, as "Delete my profile" does. Never calls
 * GET /api/me afterwards: that creates the profile again. Deleting a profile closes its open
 * projects and resets its project posting interval, so each test can post a project of its own.
 */
export async function deleteProfile(role: Role): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL, storageState: statePath(role) });
  try {
    const res = await ctx.delete('/api/me');
    expect(res.status(), `DELETE /api/me as the ${role}: ${await res.text()}`).toBe(200);
  } finally {
    await ctx.dispose();
  }
}

/** Both profiles, donor first: a pledge from a donor who is gone stays on the project as Anonymous. */
export async function deleteBothProfiles(): Promise<void> {
  for (const role of ['donor', 'researcher'] as const) await deleteProfile(role);
}

/** A browser context and page signed in as the account, from the state global-setup.ts saved. */
export async function signedIn(browser: Browser, role: Role): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL, storageState: statePath(role) });
  const page = await context.newPage();
  // Every confirm() the flow meets is one a person would accept.
  page.on('dialog', (d) => void d.accept());
  return { context, page };
}
