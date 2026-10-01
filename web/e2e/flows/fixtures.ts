import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TableClient } from '@azure/data-tables';
import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL, LOGS, RIPE_STUB_URL, TABLES, TABLES_CONNECTION_STRING } from './harness/env';
import type { RecordedRequest, Scenario } from './harness/ripe-stub';

export { expect };

/** A short random id. Every account, project title and key a test makes carries one, so tests can run in parallel. */
export function uid(): string {
  return randomBytes(6).toString('hex');
}

/**
 * A RIPE Atlas API key that is obviously fake: the UUID shape the API checks for, with zeros where a
 * real key has random digits. All of them start with FAKE_KEY_PREFIX, which the leak checks look for.
 */
export const FAKE_KEY_PREFIX = '00000000-0000-4000-8000-0000';
export function fakeKey(): string {
  return `${FAKE_KEY_PREFIX}${randomBytes(4).toString('hex')}`;
}

export type Provider = 'github' | 'aad';

export interface Principal {
  identityProvider: Provider;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims: unknown[];
}

export interface Person {
  id: string;
  name: string;
  /** The RIPE NCC Access email saved on the profile ('' when none was saved). */
  email: string;
  principal: Principal;
  context: BrowserContext;
  page: Page;
  /** Requests as this person: shares the context's cookies, and has no HTTP cache. */
  request: APIRequestContext;
}

export interface PersonOptions {
  provider?: Provider;
  /** Label used in the display name, e.g. "researcher". */
  role?: string;
  /** Save a display name and RIPE NCC Access email (default), only a display name, or nothing. */
  profile?: 'full' | 'name' | 'none';
}

/** The cookie the Static Web Apps emulator reads to decide who is signed in: the client principal, base64 JSON. */
export function principalCookie(p: Principal): string {
  return Buffer.from(JSON.stringify(p)).toString('base64');
}

/**
 * Keep every browser request on this machine. Only the local stack answers; anything else (the
 * emulator's sign-in page pulls jQuery from a CDN, for instance) is refused unless a test routes it.
 */
export async function localOnly(context: BrowserContext): Promise<void> {
  await context.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) => route.abort('blockedbyclient'));
}

export interface Visitor {
  context: BrowserContext;
  page: Page;
  request: APIRequestContext;
}

/** A browser context with nobody signed in. */
async function createVisitor(browser: Browser): Promise<Visitor> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await localOnly(context);
  return { context, page: await context.newPage(), request: context.request };
}

/** Sign a context in as this principal, as the emulator's sign-in page does. */
export async function signInAgain(context: BrowserContext, principal: Principal): Promise<void> {
  await context.addCookies([{ name: 'StaticWebAppsAuthCookie', value: principalCookie(principal), url: BASE_URL }]);
}

async function createPerson(browser: Browser, opts: PersonOptions): Promise<Person> {
  const id = uid();
  const role = opts.role ?? 'user';
  const name = `E2E ${role} ${id}`;
  const provider = opts.provider ?? 'github';
  const principal: Principal = {
    identityProvider: provider,
    userId: `e2e${id}`,
    userDetails: provider === 'aad' ? `${role}.${id}@example.org` : `${role}-${id}`,
    userRoles: ['anonymous', 'authenticated'],
    claims: [],
  };
  const context = await browser.newContext({ baseURL: BASE_URL });
  await localOnly(context);
  await signInAgain(context, principal);
  const page = await context.newPage();
  const person: Person = { id: principal.userId, name, email: '', principal, context, page, request: context.request };
  const profile = opts.profile ?? 'full';
  if (profile !== 'none') {
    const email = profile === 'full' ? `${role}-${id}@example.org` : '';
    const res = await person.request.put('/api/me', { data: { displayName: name, atlasEmail: email } });
    expect(res.status(), await res.text()).toBe(200);
    person.email = email;
  }
  return person;
}

export interface ProjectInput {
  title?: string;
  summary?: string;
  description?: string;
  creditsRequested?: number;
  tags?: string[];
}

export interface CreatedProject {
  id: string;
  title: string;
  summary: string;
  creditsRequested: number;
}

/** Post a project through the API, as the given person. */
export async function postProject(owner: Person, input: ProjectInput = {}): Promise<CreatedProject> {
  const tag = uid();
  const body = {
    title: input.title ?? `E2E project ${tag}`,
    summary: input.summary ?? `Summary for e2e project ${tag}.`,
    description: input.description ?? `Methodology for e2e project ${tag}.\n\nSecond paragraph.`,
    creditsRequested: input.creditsRequested ?? 1000,
    tags: input.tags ?? ['ping'],
  };
  const res = await owner.request.post('/api/projects', { data: body });
  expect(res.status(), await res.text()).toBe(201);
  const { project } = (await res.json()) as { project: CreatedProject };
  return project;
}

/** Every row of every table in Azurite, for the tests that check what was stored. */
export async function allRows(): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    const client = TableClient.fromConnectionString(TABLES_CONNECTION_STRING, table, { allowInsecureConnection: true });
    out[table] = [];
    for await (const row of client.listEntities()) out[table].push(row as Record<string, unknown>);
  }
  return out;
}

/** One row, or null. */
export async function row(table: (typeof TABLES)[number], partitionKey: string, rowKey: string): Promise<Record<string, unknown> | null> {
  const client = TableClient.fromConnectionString(TABLES_CONNECTION_STRING, table, { allowInsecureConnection: true });
  try {
    return (await client.getEntity(partitionKey, rowKey)) as Record<string, unknown>;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** The output of one stack process so far. */
export function stackLog(name: keyof typeof LOGS): string {
  try {
    return readFileSync(LOGS[name], 'utf8');
  } catch {
    return '';
  }
}

/** Control of the RIPE Atlas stub, per key. */
export const ripe = {
  async scenario(key: string, scenario: Scenario): Promise<void> {
    const res = await fetch(`${RIPE_STUB_URL}/__stub/scenarios`, { method: 'POST', body: JSON.stringify({ key, scenario }) });
    expect(res.status).toBe(204);
  },
  async requests(key: string): Promise<RecordedRequest[]> {
    const res = await fetch(`${RIPE_STUB_URL}/__stub/requests?key=${encodeURIComponent(key)}`);
    return ((await res.json()) as { requests: RecordedRequest[] }).requests;
  },
  /** Answer the requests this key's `held` scenario is holding. */
  async release(key: string): Promise<number> {
    const res = await fetch(`${RIPE_STUB_URL}/__stub/release`, { method: 'POST', body: JSON.stringify({ key }) });
    return ((await res.json()) as { released: number }).released;
  },
  async transactionReads(key: string): Promise<RecordedRequest[]> {
    return (await this.requests(key)).filter((r) => r.method === 'GET' && r.path.startsWith('/api/v2/credits/transactions/'));
  },
  async transfers(key: string): Promise<RecordedRequest[]> {
    return (await this.requests(key)).filter((r) => r.method === 'POST' && r.path === '/api/v2/credits/transfers/');
  },
};

/**
 * Everything a page received from /api and /.auth, as text. Used to show a key or an email address
 * never came back to a browser.
 */
export function recordResponses(page: Page): () => Promise<string[]> {
  const pending: Promise<string>[] = [];
  page.on('response', (res) => {
    const path = new URL(res.url()).pathname;
    if (path.startsWith('/api/') || path.startsWith('/.auth/') || path.startsWith('/projects/')) {
      pending.push(res.text().then((t) => `${res.request().method()} ${path}\n${t}`, () => ''));
    }
  });
  return () => Promise.all(pending);
}

interface Fixtures {
  /** Sign in a new, unique person in their own browser context. Contexts are closed after the test. */
  person: (opts?: PersonOptions) => Promise<Person>;
  /** A new browser context with nobody signed in. Contexts are closed after the test. */
  signedOut: () => Promise<Visitor>;
}

export const test = base.extend<Fixtures>({
  person: async ({ browser }, use) => {
    const made: Person[] = [];
    await use(async (opts = {}) => {
      const p = await createPerson(browser, opts);
      made.push(p);
      return p;
    });
    for (const p of made) await p.context.close();
  },
  signedOut: async ({ browser }, use) => {
    const made: Visitor[] = [];
    await use(async () => {
      const v = await createVisitor(browser);
      made.push(v);
      return v;
    });
    for (const v of made) await v.context.close();
  },
});

/** Accept every confirm() and alert() on the page, as a person clicking OK would. */
export function acceptDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', (d) => {
    seen.push(d.message());
    void d.accept();
  });
  return seen;
}
