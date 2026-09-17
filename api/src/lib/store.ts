import { TableClient, TableEntity, odata, RestError } from '@azure/data-tables';
import { HttpError } from './http';
import { PENDING_RESERVATION_DAYS } from './pledging';
import { Tag } from './validate';

export type ProjectStatus = 'open' | 'closed';
export type PledgeMethod = 'api' | 'manual';
export type PledgeStatus = 'pledged' | 'sent' | 'confirmed' | 'cancelled';

export interface User {
  id: string;
  provider: string;
  handle: string;
  displayName: string;
  atlasEmail: string; // private
  affiliation: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  summary: string;
  description: string;
  creditsRequested: number;
  creditsConfirmed: number;
  creditsPending: number;
  status: ProjectStatus;
  tags: Tag[];
  affiliation: string;
  homepageUrl: string;
  repoUrl: string;
  paperUrl: string;
  deadline: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pledge {
  id: string;
  projectId: string;
  donorId: string;
  donorName: string;
  amount: number;
  method: PledgeMethod;
  status: PledgeStatus;
  transactionUrl: string;
  /** RIPE's transaction id, when it could be looked up. The only per-transfer reference. */
  transactionId: string;
  /** When our server observed RIPE accept the transfer. */
  transferredAt: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

const USERS_PK = 'user';
const PROJECTS_PK = 'project';

type Entity = TableEntity<Record<string, unknown>>;

const clients = new Map<string, TableClient>();

function client(table: 'users' | 'projects' | 'pledges'): TableClient {
  let c = clients.get(table);
  if (!c) {
    const conn = process.env.TABLES_CONNECTION_STRING;
    if (!conn) throw new HttpError(503, 'Storage is not configured');
    c = TableClient.fromConnectionString(conn, table, { allowInsecureConnection: conn.includes('127.0.0.1') || conn.includes('UseDevelopmentStorage') });
    clients.set(table, c);
  }
  return c;
}

let ensured: Promise<void> | null = null;

/** Create the tables if they do not exist. Runs once per process; Bicep also creates them in Azure. */
export function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      for (const t of ['users', 'projects', 'pledges'] as const) {
        try {
          await client(t).createTable();
        } catch (err) {
          if (!(err instanceof RestError && err.statusCode === 409)) throw err;
        }
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

async function table(name: 'users' | 'projects' | 'pledges'): Promise<TableClient> {
  await ensureTables();
  return client(name);
}

function now(): string {
  return new Date().toISOString();
}

function notFound(): never {
  throw new HttpError(404, 'Not found');
}

async function getEntity(name: 'users' | 'projects' | 'pledges', pk: string, rk: string): Promise<Entity | null> {
  try {
    return (await (await table(name)).getEntity(pk, rk)) as Entity;
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

// ---------- users ----------

function toUser(e: Entity): User {
  return {
    id: e.rowKey,
    provider: String(e.provider ?? ''),
    handle: String(e.handle ?? ''),
    displayName: String(e.displayName ?? ''),
    atlasEmail: String(e.atlasEmail ?? ''),
    affiliation: String(e.affiliation ?? ''),
    url: String(e.url ?? ''),
    createdAt: String(e.createdAt ?? ''),
    updatedAt: String(e.updatedAt ?? ''),
  };
}

export async function getUser(id: string): Promise<User | null> {
  const e = await getEntity('users', USERS_PK, id);
  return e ? toUser(e) : null;
}

export async function ensureUser(id: string, provider: string, handle: string): Promise<User> {
  const existing = await getUser(id);
  if (existing) return existing;
  const ts = now();
  // Some identity providers put the email address in the handle, and the display name is shown
  // to anonymous visitors, so seed it with a non-address form of the handle.
  const displayName = handle.includes('@') ? handle.split('@')[0] : handle;
  const user: User = { id, provider, handle, displayName, atlasEmail: '', affiliation: '', url: '', createdAt: ts, updatedAt: ts };
  await (await table('users')).upsertEntity({ partitionKey: USERS_PK, rowKey: id, ...user }, 'Merge');
  return user;
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await (await table('users')).deleteEntity(USERS_PK, id);
  } catch (err) {
    if (!(err instanceof RestError && err.statusCode === 404)) throw err;
  }
}

export async function updateUser(id: string, patch: Partial<Pick<User, 'displayName' | 'atlasEmail' | 'affiliation' | 'url'>>): Promise<User> {
  const existing = await getUser(id);
  if (!existing) notFound();
  const updated: User = { ...existing, ...patch, updatedAt: now() };
  await (await table('users')).upsertEntity({ partitionKey: USERS_PK, rowKey: id, ...updated }, 'Replace');
  return updated;
}

// ---------- projects ----------

function toProject(e: Entity): Project {
  return {
    id: e.rowKey,
    ownerId: String(e.ownerId ?? ''),
    ownerName: String(e.ownerName ?? ''),
    title: String(e.title ?? ''),
    summary: String(e.summary ?? ''),
    description: String(e.description ?? ''),
    creditsRequested: Number(e.creditsRequested ?? 0),
    creditsConfirmed: Number(e.creditsConfirmed ?? 0),
    creditsPending: Number(e.creditsPending ?? 0),
    status: (e.status as ProjectStatus) ?? 'open',
    tags: typeof e.tags === 'string' && e.tags ? (e.tags.split(',') as Tag[]) : [],
    affiliation: String(e.affiliation ?? ''),
    homepageUrl: String(e.homepageUrl ?? ''),
    repoUrl: String(e.repoUrl ?? ''),
    paperUrl: String(e.paperUrl ?? ''),
    deadline: String(e.deadline ?? ''),
    createdAt: String(e.createdAt ?? ''),
    updatedAt: String(e.updatedAt ?? ''),
  };
}

function fromProject(p: Project): Entity {
  return { partitionKey: PROJECTS_PK, rowKey: p.id, ...p, tags: p.tags.join(',') };
}

export async function listProjects(): Promise<Project[]> {
  const out: Project[] = [];
  for await (const e of (await table('projects')).listEntities<Entity>({ queryOptions: { filter: odata`PartitionKey eq ${PROJECTS_PK}` } })) {
    out.push(toProject(e));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getProject(id: string): Promise<Project | null> {
  const e = await getEntity('projects', PROJECTS_PK, id);
  return e ? toProject(e) : null;
}

export async function createProject(p: Project): Promise<Project> {
  await (await table('projects')).createEntity(fromProject(p));
  return p;
}

export async function saveProject(p: Project): Promise<Project> {
  const updated = { ...p, updatedAt: now() };
  await (await table('projects')).upsertEntity(fromProject(updated), 'Replace');
  return updated;
}

export async function listProjectsByOwner(ownerId: string): Promise<Project[]> {
  const out: Project[] = [];
  for await (const e of (await table('projects')).listEntities<Entity>({ queryOptions: { filter: odata`PartitionKey eq ${PROJECTS_PK} and ownerId eq ${ownerId}` } })) {
    out.push(toProject(e));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------- pledges ----------

function toPledge(e: Entity): Pledge {
  return {
    id: e.rowKey,
    projectId: e.partitionKey,
    donorId: String(e.donorId ?? ''),
    donorName: String(e.donorName ?? ''),
    amount: Number(e.amount ?? 0),
    method: (e.method as PledgeMethod) ?? 'manual',
    status: (e.status as PledgeStatus) ?? 'pledged',
    transactionUrl: String(e.transactionUrl ?? ''),
    transactionId: String(e.transactionId ?? ''),
    transferredAt: String(e.transferredAt ?? ''),
    message: String(e.message ?? ''),
    createdAt: String(e.createdAt ?? ''),
    updatedAt: String(e.updatedAt ?? ''),
  };
}

export async function listPledges(projectId: string): Promise<Pledge[]> {
  const out: Pledge[] = [];
  for await (const e of (await table('pledges')).listEntities<Entity>({ queryOptions: { filter: odata`PartitionKey eq ${projectId}` } })) {
    out.push(toPledge(e));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function listPledgesByDonor(donorId: string): Promise<Pledge[]> {
  const out: Pledge[] = [];
  for await (const e of (await table('pledges')).listEntities<Entity>({ queryOptions: { filter: odata`donorId eq ${donorId}` } })) {
    out.push(toPledge(e));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getPledge(projectId: string, id: string): Promise<Pledge | null> {
  const e = await getEntity('pledges', projectId, id);
  return e ? toPledge(e) : null;
}

export async function createPledge(p: Pledge): Promise<Pledge> {
  await (await table('pledges')).createEntity({ partitionKey: p.projectId, rowKey: p.id, ...p });
  return p;
}

export async function savePledge(p: Pledge): Promise<Pledge> {
  const updated = { ...p, updatedAt: now() };
  await (await table('pledges')).upsertEntity({ partitionKey: p.projectId, rowKey: p.id, ...updated }, 'Replace');
  return updated;
}

/**
 * Sum a project's pledges. Pending pledges older than PENDING_RESERVATION_DAYS stop counting
 * towards the reserved total, so an abandoned pledge releases the capacity it was holding
 * instead of blocking the project for ever.
 */
export function totals(pledges: Pledge[], asOf: number = Date.now()): { confirmed: number; pending: number } {
  const cutoff = asOf - PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000;
  let confirmed = 0;
  let pending = 0;
  for (const p of pledges) {
    if (p.status === 'confirmed') {
      confirmed += p.amount;
    } else if (p.status === 'pledged' || p.status === 'sent') {
      const created = Date.parse(p.createdAt);
      if (!Number.isFinite(created) || created >= cutoff) pending += p.amount;
    }
  }
  return { confirmed, pending };
}

/**
 * Pledges by this donor on this project that still hold a reservation. Expiry is applied here as
 * well as in totals(), so that once a reservation lapses the donor may start a replacement rather
 * than being locked out for ever by their own abandoned pledge.
 */
export function activePledgesBy(pledges: Pledge[], donorId: string, asOf: number = Date.now()): Pledge[] {
  const cutoff = asOf - PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000;
  return pledges.filter((p) => {
    if (p.donorId !== donorId) return false;
    if (p.status !== 'pledged' && p.status !== 'sent') return false;
    const created = Date.parse(p.createdAt);
    return !Number.isFinite(created) || created >= cutoff;
  });
}

/** Recompute cached totals on the project from its pledges. */
export async function recomputeProjectTotals(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) notFound();
  const t = totals(await listPledges(projectId));
  return saveProject({ ...project, creditsConfirmed: t.confirmed, creditsPending: t.pending });
}

export { now };
