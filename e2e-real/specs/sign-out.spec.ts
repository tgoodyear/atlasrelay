import { test, expect, type BrowserContext } from '@playwright/test';
import { signedIn } from '../site';

// Signing out on the deployed site really ends the session: the header's "Sign out" link, then
// /.auth/me answers no principal and the dashboard asks to sign in. Runs last (file order), in its
// own context from the saved donor state, so the other specs keep their sessions.
//
// The site's auth cookies are listed before and after (name, domain, path, flags; never a value):
// a sign-out that clears a cookie for the wrong domain leaves the real one in place, and the list
// shows which it was.

async function authCookies(context: BrowserContext): Promise<string[]> {
  return (await context.cookies())
    .filter((c) => c.name.startsWith('StaticWebApps'))
    .map((c) => `${c.name} domain=${c.domain} path=${c.path} httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite}`);
}

test('signing out ends the session', async ({ browser }) => {
  const { context, page } = await signedIn(browser, 'donor');
  const before = await authCookies(context);
  console.log(`auth cookies while signed in: ${before.join(' | ') || 'none'}`);
  expect((await (await context.request.get('/.auth/me')).json()).clientPrincipal?.identityProvider).toBe('aad');

  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Sign out' }).click();
  // The sign-out passes through /.auth/logout (and may visit the provider) before coming home.
  await page.waitForURL((url) => url.origin === new URL(process.env.BASE_URL!).origin && !url.pathname.startsWith('/.auth/'), { timeout: 60_000 });

  const after = await authCookies(context);
  console.log(`auth cookies after signing out: ${after.join(' | ') || 'none'}`);
  const me = await (await context.request.get('/.auth/me', { headers: { 'cache-control': 'no-cache' } })).json();
  expect(me.clientPrincipal, `still signed in after signing out; cookies: ${after.join(' | ')}`).toBeNull();
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await context.close();
});
