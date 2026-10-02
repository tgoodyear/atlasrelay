import { request as playwrightRequest, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { statePath, type Role } from './accounts';
import { deleteRunProjects } from './lib/cleanup.mjs';

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

/**
 * Deletes the projects this run posted, as the researcher who posted them, through the test-only
 * route (lib/cleanup.mjs). Declared after a spec's credit-return hook and before its profile
 * deletion, so it runs after the credits are back, and runs whether or not the test passed. Logs
 * the ids it deleted; fails when one is left.
 */
export async function cleanUpRun(run: string, testInfo: TestInfo): Promise<void> {
  // Its own time on top of the test's: a test that timed out mid-transfer leaves a pledge in flight
  // for up to two minutes, and the deletion waits that out (lib/cleanup.mjs).
  testInfo.setTimeout(testInfo.timeout + 4 * 60_000);
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL, storageState: statePath('researcher') });
  try {
    await deleteRunProjects({
      list: async () => {
        // /api/my reads the account's own projects and never creates a profile, unlike /api/me.
        const res = await ctx.get('/api/my');
        expect(res.status(), `GET /api/my as the researcher: ${await res.text()}`).toBe(200);
        return ((await res.json()) as { projects: { id: string; title: string }[] }).projects;
      },
      remove: async (id) => (await ctx.delete(`/api/test/projects/${id}`)).status(),
      read: async (id) => (await ctx.get(`/api/projects/${id}`)).status(),
      log: (line) => console.log(line),
    }, run);
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
