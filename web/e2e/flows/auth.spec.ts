import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { anonymous, expect, test, uid } from './fixtures';

// Signing in through the emulator's own sign-in page, the way a person does it locally: the header
// link and the sign-in prompt lead to /.auth/login/<provider>, the emulator asks who to be, and the
// browser comes back to the page it asked for.

const jquery = createRequire(import.meta.url).resolve('jquery/dist/jquery.min.js');

/** The emulator's sign-in page loads jQuery from a CDN; serve the local copy so nothing leaves the machine. */
async function serveEmulatorAssets(page: Page): Promise<void> {
  await page.context().route(/^https:\/\/ajax\.aspnetcdn\.com\/ajax\/jquery\//, (route) =>
    route.fulfill({ path: jquery, contentType: 'application/javascript' }),
  );
}

/** Fill in the emulator's form. It saves each field on keyup, so each fill ends with a key press. */
async function completeMockSignIn(page: Page, provider: string, userId: string, userDetails: string): Promise<void> {
  await expect(page.locator('#identityProvider')).toHaveValue(provider);
  for (const [field, value] of [['#userId', userId], ['#userDetails', userDetails]] as const) {
    await page.locator(field).fill(value);
    await page.locator(field).press('End');
  }
  await page.locator('#submit').click();
}

test('sign in with GitHub, set up a profile and sign out', async ({ browser }) => {
  const { page, request } = await anonymous(browser);
  await serveEmulatorAssets(page);
  const id = `e2e${uid()}`;
  const handle = `gh-${id}`;

  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/\.auth\/login\/github\?post_login_redirect_uri=\/dashboard$/);
  await completeMockSignIn(page, 'github', id, handle);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(`Hi ${handle}.`)).toBeVisible();
  const me = await (await request.get('/.auth/me')).json();
  expect(me.clientPrincipal).toMatchObject({ identityProvider: 'github', userId: id, userDetails: handle });

  // No RIPE email yet, so the dashboard asks for one.
  await expect(page.getByText('You have not added a RIPE NCC Access email yet')).toBeVisible();
  await page.getByRole('link', { name: 'Add it in your profile.' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText(`Signed in with GitHub as ${handle}`)).toBeVisible();

  const displayName = `E2E Researcher ${id}`;
  await page.getByLabel('Display name').fill(displayName);
  // The browser accepts a@b as an email address; the API does not.
  await page.getByLabel('RIPE NCC Access email').fill('a@b');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.alert-error')).toHaveText('RIPE NCC Access email must be a valid email address');

  await page.getByLabel('RIPE NCC Access email').fill(`${id}@example.org`);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: displayName })).toBeVisible();
  const saved = await (await request.get('/api/me')).json();
  expect(saved.user).toMatchObject({ displayName, atlasEmail: `${id}@example.org`, hasAtlasEmail: true, provider: 'github' });

  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await (await request.get('/.auth/me')).json()).clientPrincipal).toBeNull();
  expect((await request.get('/api/me')).status()).toBe(401);
});

test('sign in with Microsoft from the sign-in prompt', async ({ browser }) => {
  const { page, request } = await anonymous(browser);
  await serveEmulatorAssets(page);
  const id = `e2e${uid()}`;
  const email = `ms.${id}@example.org`;

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await expect(page).toHaveURL(/\/\.auth\/login\/aad\?post_login_redirect_uri=%2Fdashboard$/);
  await completeMockSignIn(page, 'aad', id, email);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const me = await (await request.get('/api/me')).json();
  expect(me.principal.provider).toBe('aad');
  expect(me.user.id).toBe(id);

  await page.goto('/profile');
  await expect(page.getByText(`Signed in with Microsoft as ${email}`)).toBeVisible();
  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
