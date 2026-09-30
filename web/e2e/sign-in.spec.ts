import { expect, test, type Page } from '@playwright/test';

// A click on a sign-in link has to reach App Insights as a sign-in-clicked event before the
// browser leaves for the identity provider, and must never keep the visitor from signing in.
// See onLinkClick in src/lib/telemetry.ts.

interface Envelope {
  name?: string;
  data?: { baseType?: string; baseData?: { name?: string; properties?: Record<string, string> } };
}

interface Stubs {
  /** Everything that happened, in order: "event:<name>:<provider>" per event posted, "login:<provider>". */
  log: string[];
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

async function stub(page: Page, opts: { ingestion?: 'accept' | 'abort'; sdkDelayMs?: number; sdk?: 'abort' } = {}): Promise<Stubs> {
  const stubs: Stubs = { log: [] };
  await page.route('**/*.in.applicationinsights.azure.com/**', async (route) => {
    if (opts.ingestion === 'abort') return route.abort('blockedbyclient');
    for (const e of envelopes(route.request().postData() ?? '')) {
      const base = e.data?.baseData;
      if (e.data?.baseType === 'EventData') stubs.log.push(`event:${base?.name}:${base?.properties?.provider ?? ''}`);
      else if (e.data?.baseType) stubs.log.push(e.data.baseType);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"itemsReceived":1,"itemsAccepted":1,"errors":[]}' });
  });
  await page.route('**/.auth/me', (route) => route.fulfill({ json: { clientPrincipal: null } }));
  await page.route('**/.auth/login/**', (route) => {
    const provider = /\/\.auth\/login\/([^/?]+)/.exec(route.request().url())?.[1];
    stubs.log.push(`login:${provider}`);
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
