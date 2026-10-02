import { expect, test } from '@playwright/test';
import { checkAxe, checkSignInButtons, DESKTOP, MOBILE } from '../signin-buttons';

// All four sign-in buttons, in the build with every provider (the test-site project builds as dev
// does, with GitHub, Microsoft, Google and ORCID). The tests answer /.auth and /api themselves.

for (const [name, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]] as const) {
  test(`on ${name}, all four sign-in buttons have their names, marks, AA contrast and no axe violations`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/.auth/me', (route) => route.fulfill({ json: { clientPrincipal: null } }));
    await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'not in this test' } }));
    await page.goto('/signin');
    const links = await checkSignInButtons(page, ['GitHub', 'Microsoft', 'Google', 'ORCID']);
    await expect(links[2]).toHaveAttribute('href', '/.auth/login/google?post_login_redirect_uri=%2Fdashboard');
    await expect(links[3]).toHaveAttribute('href', '/.auth/login/orcid?post_login_redirect_uri=%2Fdashboard');
    await checkAxe(page);
  });
}
