import { expect, test, type Page } from '@playwright/test';

// A click on a sign-in link has to reach App Insights as a sign-in-clicked event before the
// browser leaves for the identity provider, and must never keep the visitor from signing in.
// See onLinkClick in src/lib/telemetry.ts.

interface Envelope {
  name?: string;
  data?: { baseType?: string; baseData?: { name?: string; properties?: Record<string, string> } };
}

interface Stubs {
  /**
   * Everything that happened, in order: "event:<name>:<provider>" per event posted, "answered:<name>"
   * once the ingestion stub has replied to it, "login:<provider>" when the browser asks for the
   * sign-in URL.
   */
  log: string[];
  /** When each log entry was made (Date.now()), by entry. */
  at: Record<string, number>;
}

function envelopes(body: string): Envelope[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]) as Envelope[];
  } catch {
    return body
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Envelope];
        } catch {
          return [];
        }
      });
  }
}

interface StubOptions {
  ingestion?: 'accept' | 'abort';
  /** How long the ingestion stub takes to answer a request that carries sign-in-clicked. */
  signInReplyDelayMs?: number;
  sdkDelayMs?: number;
  sdk?: 'abort';
}

async function stub(page: Page, opts: StubOptions = {}): Promise<Stubs> {
  const stubs: Stubs = { log: [], at: {} };
  const record = (entry: string) => {
    stubs.log.push(entry);
    stubs.at[entry] ??= Date.now();
  };
  await page.route('**/*.in.applicationinsights.azure.com/**', async (route) => {
    if (opts.ingestion === 'abort') return route.abort('blockedbyclient');
    let signIn = false;
    for (const e of envelopes(route.request().postData() ?? '')) {
      const base = e.data?.baseData;
      if (e.data?.baseType === 'EventData') record(`event:${base?.name}:${base?.properties?.provider ?? ''}`);
      else if (e.data?.baseType) record(e.data.baseType);
      if (base?.name === 'sign-in-clicked') signIn = true;
    }
    if (signIn && opts.signInReplyDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.signInReplyDelayMs));
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"itemsReceived":1,"itemsAccepted":1,"errors":[]}' });
    } catch {
      // The page has already gone (the timeout test), so the reply has nowhere to go.
    }
    if (signIn) record('answered:sign-in-clicked');
  });
  await page.route('**/.auth/me', (route) => route.fulfill({ json: { clientPrincipal: null } }));
  await page.route('**/.auth/login/**', (route) => {
    const provider = /\/\.auth\/login\/([^/?]+)/.exec(route.request().url())?.[1];
    record(`login:${provider}`);
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Identity provider</title>' });
  });
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'not in this test' } }));
  if (opts.sdk === 'abort' || opts.sdkDelayMs) {
    await page.route('**/assets/telemetry-sdk-*.js', async (route) => {
      if (opts.sdk === 'abort') return route.abort('blockedbyclient');
      await new Promise((resolve) => setTimeout(resolve, opts.sdkDelayMs));
      return route.continue();
    });
  }
  return stubs;
}

test('header sign-in sends sign-in-clicked before following the link', async ({ page }) => {
  const stubs = await stub(page);
  await page.goto('/');
  // Wait for the SDK to be running: it sends the first page view.
  await expect.poll(() => stubs.log).toContain('PageviewData');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL('**/.auth/login/github?post_login_redirect_uri=/dashboard');
  await expect.poll(() => stubs.log).toContain('login:github');
  const event = stubs.log.indexOf('event:sign-in-clicked:github');
  expect(event, stubs.log.join(' ')).toBeGreaterThanOrEqual(0);
  expect(event).toBeLessThan(stubs.log.indexOf('login:github'));
});

test('a click before the SDK has loaded waits for it, then sends and follows the link', async ({ page }) => {
  const stubs = await stub(page, { sdkDelayMs: 400 });
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await page.waitForURL('**/.auth/login/aad?post_login_redirect_uri=%2Fdashboard');
  await expect.poll(() => stubs.log).toContain('login:aad');
  const event = stubs.log.indexOf('event:sign-in-clicked:aad');
  expect(event, stubs.log.join(' ')).toBeGreaterThanOrEqual(0);
  expect(event).toBeLessThan(stubs.log.indexOf('login:aad'));
});

test('a slow ingestion reply holds the link until it arrives', async ({ page }) => {
  const stubs = await stub(page, { signInReplyDelayMs: 600 });
  await page.goto('/');
  await expect.poll(() => stubs.log).toContain('PageviewData');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL('**/.auth/login/github**');
  await expect.poll(() => stubs.log).toContain('login:github');
  expect(stubs.log.indexOf('answered:sign-in-clicked'), stubs.log.join(' ')).toBeGreaterThanOrEqual(0);
  expect(stubs.log.indexOf('answered:sign-in-clicked')).toBeLessThan(stubs.log.indexOf('login:github'));
});

test('an ingestion reply slower than 1.5 s does not hold the link longer', async ({ page }) => {
  const stubs = await stub(page, { signInReplyDelayMs: 5000 });
  await page.goto('/');
  await expect.poll(() => stubs.log).toContain('PageviewData');
  const start = Date.now();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL('**/.auth/login/github**', { timeout: 4000 });
  await expect.poll(() => stubs.log).toContain('login:github');
  const held = stubs.at['login:github'] - start;
  expect(stubs.log).toContain('event:sign-in-clicked:github');
  expect(stubs.log).not.toContain('answered:sign-in-clicked');
  expect(held).toBeGreaterThanOrEqual(1400);
  expect(held).toBeLessThan(2500);
});

for (const blocked of ['ingestion', 'sdk'] as const) {
  test(`sign-in still works within 1.5 s when the ${blocked === 'sdk' ? 'SDK cannot load' : 'ingestion endpoint is blocked'}`, async ({ page }) => {
    const stubs = await stub(page, blocked === 'sdk' ? { sdk: 'abort' } : { ingestion: 'abort', sdkDelayMs: 200 });
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Sign in' });
    await link.waitFor();
    const start = Date.now();
    await link.click();
    await page.waitForURL('**/.auth/login/github**', { timeout: 3000 });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(stubs.log).toContain('login:github');
  });
}

test('ctrl-click and middle-click on a sign-in link are left to the browser', async ({ page }) => {
  await stub(page, { sdkDelayMs: 2000 });
  await page.goto('/');
  // Runs after the telemetry listener (capture, on document). Records whether it held the click,
  // then stops the browser opening a tab.
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    for (const type of ['click', 'auxclick']) {
      window.addEventListener(type, (e) => {
        seen.push(e.defaultPrevented);
        e.preventDefault();
      });
    }
  });
  const link = page.getByRole('link', { name: 'Sign in' });
  await link.click({ modifiers: ['ControlOrMeta'] });
  await link.click({ button: 'middle' });
  expect(await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen)).toEqual([false, false]);
  expect(new URL(page.url()).pathname).toBe('/');
});
