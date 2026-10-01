import type { Locator, Page } from '@playwright/test';
import type { Credentials } from './accounts';
import { totp } from './lib/totp.mjs';

// Signs one account in through the site's "Continue with Microsoft" link and the real Microsoft
// sign-in pages. The pages come in a different order depending on the account and the tenant, so
// this looks at what is on screen and answers it, until the browser is back on the site:
//
//   Pick an account      the account's tile, else "Use another account"
//   Sign in (email)      the username
//   Enter password       the password
//   Verify your identity the authenticator app's code, when the account has a seed
//   Enter code           a TOTP code, when the account has a seed (see lib/totp.mjs)
//   Stay signed in?      No
//   Permissions requested  Accept (a test tenant that lets users consent to apps)
//   Static Web Apps consent  Grant Consent
//
// Anything else that asks for input (register MFA, change the password, an error) stops the
// sign-in with a message naming the page. Nothing here writes a password to a log or a message.

const PRIMARY = '#idSIButton9, [data-testid="primaryButton"], input[type="submit"], button[type="submit"]';

interface Screen {
  name: string;
  locator: (page: Page) => Locator;
}

const SCREENS: Screen[] = [
  { name: 'error', locator: (p) => p.locator('#usernameError, #passwordError, #idTD_Error, #errorText, [data-testid="error"]').filter({ hasText: /\S/ }) },
  // The code prompt comes before the registration check: both can carry MFA wording.
  { name: 'totp', locator: (p) => p.locator('input[name="otc"]') },
  { name: 'mfa-method', locator: (p) => p.locator('[data-value="PhoneAppOTP"]') },
  { name: 'mfa-registration', locator: (p) => p.locator('#ProofUpDescription, [data-testid="proofUpTitle"]').or(p.getByText(/More information required|Let's keep your account secure/i)) },
  { name: 'password-change', locator: (p) => p.locator('input[name="newpasswd"], #iPassword') },
  { name: 'pick-account', locator: (p) => p.locator('#tilesHolder, [data-test-id="accountList"], [data-testid="accountList"]') },
  { name: 'password', locator: (p) => p.locator('input[name="passwd"], input[type="password"]') },
  { name: 'username', locator: (p) => p.locator('input[name="loginfmt"], input[type="email"]') },
  { name: 'stay-signed-in', locator: (p) => p.locator('#KmsiCheckboxField, #KmsiDescription, [data-testid="kmsiVideo"]').or(p.getByText(/^Stay signed in\?$/)) },
  { name: 'permissions', locator: (p) => p.getByText(/^Permissions requested$/) },
  { name: 'swa-consent', locator: (p) => p.getByRole('button', { name: /Grant Consent/i }) },
];

async function visible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function onScreen(page: Page): Promise<string | null> {
  for (const s of SCREENS) if (await visible(s.locator(page))) return s.name;
  return null;
}

/**
 * Microsoft's sign-in page shows its fields before its script has bound them. A value filled in
 * that gap is on screen but not in the page's model, so it submits an empty field ("Enter a valid
 * email address"); seen in the job's container, where pages load slower than on a laptop. Wait for
 * the page to load, then type, and check the value stuck.
 */
async function fillWhenReady(page: Page, field: Locator, value: string): Promise<void> {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt++) {
    await field.fill('');
    await field.pressSequentially(value, { delay: 20 });
    if ((await field.inputValue()) === value) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Microsoft sign-in did not take the typed value');
}

async function submit(page: Page, field?: Locator): Promise<void> {
  const button = page.locator(PRIMARY).first();
  if (await visible(button)) await button.click();
  else if (field) await field.press('Enter');
}

/**
 * @param page a page in a context that is not traced
 * @param siteOrigin e.g. https://dev.atlasrelay.org; signing in is done when the page is back there
 */
export async function signInWithMicrosoft(page: Page, account: Credentials, siteOrigin: string): Promise<void> {
  await page.goto(`${siteOrigin}/.auth/login/aad?post_login_redirect_uri=/profile`);
  const deadline = Date.now() + 120_000;
  const seen: string[] = [];
  let lastTotpWindow = -1;
  let usernameRetried = false;
  let last = { screen: '', at: 0 };
  while (Date.now() < deadline) {
    const url = new URL(page.url());
    if (url.origin === siteOrigin && !url.pathname.startsWith('/.auth/')) return;
    const screen = await onScreen(page);
    if (!screen) {
      await page.waitForTimeout(500);
      continue;
    }
    if (seen.at(-1) !== screen) seen.push(screen);
    // The page takes a moment to move on after an answer. Answering the same screen again inside
    // that moment would submit twice.
    if (screen === last.screen && Date.now() - last.at < 4000) {
      await page.waitForTimeout(500);
      continue;
    }
    last = { screen, at: Date.now() };
    switch (screen) {
      case 'error': {
        const text = (await page.locator('#usernameError, #passwordError, #idTD_Error, #errorText, [data-testid="error"]').first().innerText()).trim();
        // "Enter a valid email address" means the page saw an empty field, not a wrong account:
        // the username went in before the page was ready. Start that screen again, once.
        if (/valid email address/i.test(text) && !usernameRetried) {
          usernameRetried = true;
          last = { screen: '', at: 0 };
          await page.reload();
          break;
        }
        throw new Error(`Microsoft sign-in refused the account: ${text.slice(0, 300)}`);
      }
      case 'mfa-method':
        // "Verify your identity" with more than one method: pick the code from an authenticator app.
        if (!account.totp) throw new Error('Microsoft asks this account to verify with MFA, and it has no TOTP seed in the vault (docs/RUNBOOK.md).');
        await page.locator('[data-value="PhoneAppOTP"]').first().click();
        break;
      case 'mfa-registration':
        throw new Error('Microsoft asks this account to register for MFA. Add it to the MFA Exempt group in the test tenant, check security defaults are off, or give the account a TOTP seed (docs/RUNBOOK.md).');
      case 'password-change':
        throw new Error('Microsoft asks this account to change its password. Sign in once by hand, set a new one, and run scripts/set-test-users.sh again.');
      case 'pick-account': {
        const tile = page.locator('[data-test-id], [role="button"], [role="listitem"]').filter({ hasText: account.username }).first();
        if (await visible(tile)) await tile.click();
        else await page.locator('#otherTile, [data-test-id="otherTile"]').or(page.getByText('Use another account')).first().click();
        break;
      }
      case 'username': {
        const field = SCREENS.find((s) => s.name === 'username')!.locator(page).first();
        await fillWhenReady(page, field, account.username);
        await submit(page, field);
        break;
      }
      case 'password': {
        const field = SCREENS.find((s) => s.name === 'password')!.locator(page).first();
        await fillWhenReady(page, field, account.password);
        await submit(page, field);
        break;
      }
      case 'totp': {
        if (!account.totp) throw new Error('Microsoft asks this account for a verification code, and it has no TOTP seed in the vault (docs/RUNBOOK.md).');
        // One code per 30-second window: a code Microsoft has already accepted or refused is not
        // sent twice.
        const window = Math.floor(Date.now() / 30_000);
        if (window === lastTotpWindow) {
          await page.waitForTimeout(1000);
          break;
        }
        lastTotpWindow = window;
        const field = page.locator('input[name="otc"]').first();
        await field.fill(totp(account.totp));
        await page.locator('#idSubmit_SAOTCC_Continue').or(page.locator(PRIMARY)).first().click();
        break;
      }
      case 'stay-signed-in':
        await page.locator('#idBtn_Back, [data-testid="secondaryButton"]').or(page.getByRole('button', { name: 'No' })).first().click();
        break;
      case 'permissions':
        await submit(page);
        break;
      case 'swa-consent':
        await page.getByRole('button', { name: /Grant Consent/i }).first().click();
        break;
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(750);
  }
  throw new Error(`Microsoft sign-in did not return to ${siteOrigin} within two minutes (pages seen: ${seen.join(', ') || 'none'}; last at ${new URL(page.url()).host})`);
}
