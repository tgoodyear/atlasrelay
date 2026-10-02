import { TableClient, TableEntity, odata, RestError } from '@azure/data-tables';
import { HttpError } from './http';
import { newId } from './ids';
import { PENDING_RESERVATION_DAYS, projectPostAllowed } from './pledging';
import { Tag } from './validate';
import { logError, tableDependencyPolicy } from './telemetry';
import { createTableClient, tableAccess } from './tables';

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
  /** Table Storage row version, for conditional writes. Never published. */
  etag?: string;
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
  /**
   * What came of the work, written by the owner after the credits were spent. Public, plain text.
   *
   * Deliberately separate from paperUrl. paperUrl is the proposal that justified the ask;
   * resultsUrl is what came out of it. Folding one into the other would erase the only distinction
   * these three fields exist to record, which is whether the researcher ever reported back.
   */
  resultsSummary: string;
  resultsUrl: string;
  /**
   * Stamped the first time either of the two above goes non-empty, and never cleared afterwards.
   *
   * This is the field the feature is for: "N of M funded projects reported results" is a count
   * over the projects partition with no join. It is stored rather than derived from the text
   * because a researcher who posts a write-up and later edits it down to nothing would otherwise
   * silently go back to never having reported, and because the date they reported is itself the
   * answer people want.
   *
   * It is not a cache, unlike totalsCheckedAt and totalsDirty below: the handler that writes the
   * two fields it describes writes this in the same patch, and nothing else ever refreshes it, so
   * there is no path by which it can drift from what it summarises.
   */
  resultsPostedAt: string;
  /**
   * Set by an operator when a project is taken down. Closing alone is not a takedown, because the
   * owner can reopen their own project; this is the flag that says the closure was not theirs to
   * undo. Only an operator, working directly against Table Storage, can clear it.
   */
  moderationClosed: boolean;
  createdAt: string;
  updatedAt: string;
  /** Table Storage row version, for conditional writes. Never published. */
  etag?: string;
  /**
   * When the listing last recomputed this project's totals. Maintenance bookkeeping, kept apart
   * from updatedAt so that rotating through refresh candidates does not make a project look
   * freshly edited to the people reading it.
   */
  totalsCheckedAt?: string;
  /**
   * Set when a recompute could not be written. Both maintenance refreshers only look at projects
   * showing a reservation, and a confirmed API pledge leaves pending at zero, so without this a
   * failed write would never be repaired: there is no "next pledge" to fix it and nothing else
   * rebuilds the cache.
   */
  totalsDirty?: boolean;
  /**
   * Table Storage's own last-write time for the row. Unlike updatedAt it moves on every write,
   * including an operator's takedown merged by hand and maintenance writes that deliberately keep
   * updatedAt. Read only by profile deletion, to tell whether a project changed recently. Never published.
   */
  storedAt?: string;
  /**
   * Posted by the full-flow tests on a test environment, so DELETE /api/test/projects/{id} may remove
   * it (lib/testCleanup.ts). Written only at creation, and only where E2E_PROJECT_CLEANUP is on, so
   * no prod row ever has it and no edit can add it. Never published.
   */
  createdByTests?: boolean;
}

export interface Pledge {
  id: string;
  projectId: string;
  donorId: string;
  donorName: string;
  /**
   * The donor asked not to be named on the public listing. The row still records who pledged --
   * the platform has to know, to enforce one live pledge per donor and to show them their own
   * pledges -- so this withholds the name from public views rather than discarding it. The project
   * owner still sees it: they confirm manual transfers themselves, and for any pledge they may
   * need to reconcile it against their own RIPE transaction log, which names the sending account.
   * (An API transfer is confirmed by this server once it watches RIPE accept it, not by them.)
   */
  anonymous: boolean;
  amount: number;
  method: PledgeMethod;
  status: PledgeStatus;
  transactionUrl: string;
  /** RIPE's transaction id, when it could be looked up. The only per-transfer reference. */
  transactionId: string;
  /** When our server observed RIPE accept the transfer. */
  transferredAt: string;
  /**
   * Set when an API transfer was sent but RIPE never answered, so we cannot say whether the
   * credits moved. The pledge waits at `sent` for a human to settle it either way.
   */
  transferUncertain: boolean;
  /**
   * Set while this request is still attempting the transfer. The row has to exist before the
   * credits move, but until the attempt resolves nobody may act on it: confirming or cancelling
   * releases the donor's slot, which would let a second transfer start while the first is still
   * in flight.
   */
  inFlight: boolean;
  /**
   * When the transfer attempt began. The in-flight window is measured from here rather than from
   * createdAt, because the row is written first and the claim, the balance check and validation
   * all happen in between: anchoring to creation could let the window lapse before the transfer
   * was even issued, and an owner could then free the slot while the credits were moving.
   */
  inFlightSince: string;
  /**
   * What actually arrived, when the project owner confirmed a manual pledge with a RIPE Atlas key
   * and the API read the matching row from their transaction log. 0 means nobody read it, which
   * is every API pledge, every pledge confirmed without a key, and every row written before this
   * field existed. `amount` keeps what the donor pledged either way. See creditedAmount.
   */
  receivedAmount: number;
  /**
   * The API read receivedAmount and transactionId from the owner's RIPE Atlas transaction log
   * itself, in the request that confirmed the pledge. Never set from anything the browser sent.
   */
  amountVerified: boolean;
  message: string;
  createdAt: string;
  updatedAt: string;
  /** Table Storage row version, for conditional writes. Never published. */
  etag?: string;
}

const USERS_PK = 'user';
const PROJECTS_PK = 'project';

type Entity = TableEntity<Record<string, unknown>>;

const clients = new Map<string, TableClient>();

function access() {
  const a = tableAccess(process.env);
  if (!a) throw new HttpError(503, 'Storage is not configured');
  return a;
}

function client(table: 'users' | 'projects' | 'pledges' | 'claims'): TableClient {
  let c = clients.get(table);
  if (!c) {
    c = createTableClient(access(), table, {
      // One log line per storage request (table, operation kind, status, duration), which is how
      // Table Storage calls show up in Application Insights: the Functions host does not track
      // dependencies for Node apps. See lib/telemetry.ts.
      additionalPolicies: [{ policy: tableDependencyPolicy(), position: 'perRetry' }],
    });
    clients.set(table, c);
  }
  return c;
}

let ensured: Promise<void> | null = null;

/**
 * Create the tables if they do not exist, once per process, when the API runs on a connection
 * string (Azurite). In Azure the tables are declared in Bicep, and the API's identity may read and
 * write rows in those four tables but not create tables, so there is nothing to do.
 */
export function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      if (access().kind !== 'connection-string') return;
      // In parallel: this runs on the first request every cold instance serves, so four sequential
      // round trips were four waits added to the slowest request the site has.
      await Promise.all((['users', 'projects', 'pledges', 'claims'] as const).map(async (t) => {
        try {
          await client(t).createTable();
        } catch (err) {
          if (!(err instanceof RestError && err.statusCode === 409)) throw err;
        }
      }));
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

async function table(name: 'users' | 'projects' | 'pledges' | 'claims'): Promise<TableClient> {
  await ensureTables();
  return client(name);
}

function now(): string {
  return new Date().toISOString();
}

function notFound(): never {
  throw new HttpError(404, 'Not found');
}

async function getEntity(name: 'users' | 'projects' | 'pledges' | 'claims', pk: string, rk: string): Promise<Entity | null> {
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
    etag: typeof e.etag === 'string' ? e.etag : undefined,
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
  // updateEntity, not upsertEntity, and conditional on the version we read. An unconditional
  // upsert here would recreate a profile that was deleted between the read above and this write,
  // putting the RIPE NCC Access email back after the person had asked for it to be removed and
  // been told it was. A 404 or 412 means exactly that happened, and the right answer is to fail.
  try {
    await (await table('users')).updateEntity(
      { partitionKey: USERS_PK, rowKey: id, ...updated } as TableEntity,
      'Replace',
      existing.etag ? { etag: existing.etag } : undefined,
    );
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 404 || err.statusCode === 412)) notFound();
    throw err;
  }
  return updated;
}

// ---------- projects ----------

/**
 * The row's system Timestamp as an ISO string. Against Azurite the SDK hands it back as a string;
 * accept a Date as well, since the SDK's typing allows either and a value silently dropped here
 * would make profile deletion fall back to updatedAt, which an operator's hand-made close leaves old.
 */
export function storageTimestamp(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
  return undefined;
}

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
    // Defaulted like every other string, which is the whole migration: Table Storage is
    // schemaless, so a project row written before these columns existed reads back with empty
    // results and no backfill pass has to run over the partition.
    resultsSummary: String(e.resultsSummary ?? ''),
    resultsUrl: String(e.resultsUrl ?? ''),
    resultsPostedAt: String(e.resultsPostedAt ?? ''),
    moderationClosed: e.moderationClosed === true,
    etag: typeof e.etag === 'string' ? e.etag : undefined,
    totalsCheckedAt: typeof e.totalsCheckedAt === 'string' ? e.totalsCheckedAt : undefined,
    totalsDirty: e.totalsDirty === true,
    storedAt: storageTimestamp(e.timestamp),
    // Only when set, so a row without the column reads back exactly as it did before it existed.
    ...(e.createdByTests === true ? { createdByTests: true } : {}),
    createdAt: String(e.createdAt ?? ''),
    updatedAt: String(e.updatedAt ?? ''),
  };
}

function fromProject(p: Project): Entity {
  const { storedAt: _storedAt, ...rest } = p;
  return { partitionKey: PROJECTS_PK, rowKey: p.id, ...rest, tags: p.tags.join(',') };
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

/**
 * Which projects an owner has, as a keyed partition beside the projects themselves (#19).
 *
 * The projects partition is a single constant key, so "this owner's projects" used to be a filter on
 * ownerId over every row on the site. That query enforces the open-project cap and drives profile
 * deletion, and closed projects are never pruned, so one account posting and closing in a loop made every
 * other account's creates, reopens and deletions read more. Keyed by owner, what a lookup reads is that
 * owner's own history and nobody else's, so the cost of posting a lot lands on the account doing it.
 *
 * Membership only, written once, never updated. ownerId never changes on a project, so there is nothing
 * to keep in step: status is read from the project row itself, which is the only place it is written.
 * A status copy here would be the derived state #19 warned about -- a close or an operator takedown made
 * directly in storage that missed the index would leave it lying about the cap.
 *
 * Lives in the projects table under its own partition prefix, which every projects query already
 * excludes because each one filters on PartitionKey. A separate table would need a Bicep change for the
 * same effect.
 */
function ownerIndexPk(ownerId: string): string {
  return `owner-${ownerId}`;
}

export async function createProject(p: Project): Promise<Project> {
  const t = await table('projects');
  // The index row first. A project row with no index entry is invisible to the cap and to deletion's
  // close sweep; an index entry with no project row is skipped by every reader. So if the second write
  // fails, the first must be the harmless one.
  await t.upsertEntity({ partitionKey: ownerIndexPk(p.ownerId), rowKey: p.id, createdAt: p.createdAt }, 'Replace');
  await t.createEntity(fromProject(p));
  return p;
}

/**
 * Change named fields on a project, leaving every other column as it is.
 *
 * Nothing replaces a whole project row any more, and nothing should. A replace writes back
 * whatever snapshot the caller happens to hold, so it silently reverts anything that changed
 * between the read and the write: a pledge recompute's credit totals, an operator's takedown
 * flag, or the owner's own edit from another tab. saveProject did exactly that and was deleted
 * once its last caller moved to this, so the only way back to that bug is for somebody to write a
 * new replace by hand.
 *
 * tags is stored comma-joined, exactly as fromProject writes it, because a raw array would either
 * be rejected by Table Storage or persisted in a shape nothing can read back.
 */
/**
 * Issue the merge for patchProject. Separated so the conditional-write contract can be tested: an
 * ifMatch that is accepted and then dropped makes every caller believe it is writing conditionally
 * while it silently overwrites whatever landed in between, and the 412 its retry waits for never
 * comes. With an ETag this is a conditional merge; without one it is an unconditional merge.
 */
export function projectPatchEntity(id: string, patch: Partial<Project>): Record<string, unknown> {
  const { tags, ...rest } = patch;
  // updatedAt first so an explicit one in the patch wins. A maintenance write that only refreshes
  // cached totals passes the existing value through, because bumping it would tell every reader
  // the project had just been edited when nothing about it changed.
  const entity: Record<string, unknown> = { partitionKey: PROJECTS_PK, rowKey: id, updatedAt: now(), ...rest };
  if (tags !== undefined) entity.tags = tags.join(',');
  return entity;
}

export async function projectUpdateArgs(
  client: { updateEntity(entity: never, mode: never, options?: never): Promise<unknown> },
  id: string,
  patch: Partial<Project>,
  ifMatch?: string,
): Promise<void> {
  await client.updateEntity(
    projectPatchEntity(id, patch) as never,
    'Merge' as never,
    (ifMatch ? { etag: ifMatch } : undefined) as never,
  );
}

export async function patchProject(id: string, patch: Partial<Project>, ifMatch?: string): Promise<Project> {
  await projectUpdateArgs(await table('projects'), id, patch, ifMatch);
  const after = await getProject(id);
  if (!after) notFound();
  return after;
}

/**
 * What resultsPostedAt should hold after a write that carries results fields.
 *
 * Split out of the update handler and kept pure so the rule can be stated once and tested, the
 * way projectPatchEntity is. The rule has two halves that are easy to get wrong in opposite
 * directions. Stamping on every save would turn "when the researcher reported" into "when they
 * last fixed a typo", which is the one number this feature exists to produce. Clearing it when
 * the text goes empty would let a report be retracted with no trace, and would make a funded
 * project that did report indistinguishable from one that never did.
 *
 * An undefined field in the patch means the caller did not send it, so it cannot trigger a stamp;
 * an empty string means they sent it empty, which cannot either. Two PATCHes racing here both
 * compute the same "first time" against their own read and both write a timestamp seconds apart,
 * which is why this needs no conditional write: either value is a true answer to the question the
 * field asks, and an ETag retry loop would be ceremony over a difference nobody can observe.
 */
export function nextResultsPostedAt(
  current: string,
  patch: { resultsSummary?: string; resultsUrl?: string },
  at: string,
): string {
  if (current) return current;
  return patch.resultsSummary || patch.resultsUrl ? at : '';
}

/** The owner's open projects, for the cap. Read through the owner index; see listProjectsByOwner. */
export async function listOpenProjectsByOwner(ownerId: string): Promise<Project[]> {
  return (await listProjectsByOwner(ownerId)).filter((p) => p.status === 'open');
}

/**
 * The per-account window on posting projects, held as a row.
 *
 * Returns false when this account posted less than minIntervalMs ago, and takes the window when it
 * did not. Reading a stamp and then writing one cannot enforce an interval, for the same reason
 * the pledge claim above spells out and the open-project cap had to learn twice: a burst of
 * concurrent posts all read before any of them writes, all see an old stamp, and all proceed.
 * Creating a row is atomic and a conditional replace is atomic, so exactly one request in a burst
 * takes the window and the rest are refused.
 *
 * The row lives in the users table under its own partition, not on the user row. A second writer
 * on the user row would collide with updateUser's conditional replace, and updateUser answers a
 * 412 with 404 Not found -- so posting a project would make a profile save being written at the
 * same moment report that the profile was gone. It is kept out of the claims table for the reverse
 * reason: that table is the one guard against a double transfer, and nothing that is not a pledge
 * claim belongs in it.
 */
const PROJECT_POST_PK = 'project-post';

export async function acquireProjectPostWindow(userId: string, minIntervalMs: number): Promise<boolean> {
  const t = await table('users');
  const entity = { partitionKey: PROJECT_POST_PK, rowKey: userId, lastProjectAt: now() };
  try {
    await t.createEntity(entity);
    return true;
  } catch (err) {
    if (!(err instanceof RestError && err.statusCode === 409)) throw err;
  }

  const held = await getEntity('users', PROJECT_POST_PK, userId);
  // Gone between the create and this read: profile deletion drops this row. Start again rather
  // than refuse, because there is now no stamp to refuse on.
  if (!held) return acquireProjectPostWindow(userId, minIntervalMs);

  if (!projectPostAllowed(String(held.lastProjectAt ?? ''), minIntervalMs)) return false;

  try {
    await t.updateEntity(entity, 'Replace', { etag: String(held.etag ?? '') });
    return true;
  } catch (err) {
    // 412 means another post by this account took the window between our read and our write. Two
    // posts inside the interval is exactly what this refuses, so the rival winning is the answer.
    if (err instanceof RestError && (err.statusCode === 412 || err.statusCode === 404)) return false;
    throw err;
  }
}

/**
 * Drop the posting window. Called when a profile is deleted, because the row is keyed by account
 * id and so is an identifier of an account that asked to be removed.
 */
export async function deleteProjectPostWindow(userId: string): Promise<void> {
  try {
    await (await table('users')).deleteEntity(PROJECT_POST_PK, userId);
  } catch (err) {
    if (!(err instanceof RestError && err.statusCode === 404)) throw err;
  }
}

/** Point reads in flight at once when resolving an owner's index. */
const OWNER_READ_CONCURRENCY = 16;

/**
 * Every project an owner has posted, newest first: one keyed partition query for the ids, then a point
 * read per project. Status comes from the project rows, so a close or a takedown is seen the moment it is
 * written, however it was written.
 *
 * An index entry whose project row does not exist is skipped. createProject writes the entry first, so a
 * create that failed halfway leaves exactly that, and it is not a project.
 */
export async function listProjectsByOwner(ownerId: string): Promise<Project[]> {
  const ids: string[] = [];
  for await (const e of (await table('projects')).listEntities<Entity>({
    queryOptions: { filter: odata`PartitionKey eq ${ownerIndexPk(ownerId)}`, select: ['RowKey'] },
  })) {
    ids.push(e.rowKey);
  }
  const out: Project[] = [];
  for (let i = 0; i < ids.length; i += OWNER_READ_CONCURRENCY) {
    const batch = await Promise.all(ids.slice(i, i + OWNER_READ_CONCURRENCY).map((id) => getProject(id)));
    // ownerId is checked rather than trusted: the index is keyed by it, but the project row is the record.
    for (const p of batch) if (p && p.ownerId === ownerId) out.push(p);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Delete one row; false when it was already gone. */
async function deleteRow(t: TableClient, partitionKey: string, rowKey: string): Promise<boolean> {
  try {
    await t.deleteEntity(partitionKey, rowKey);
    return true;
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return false;
    throw err;
  }
}

/** Delete every row a query returns; how many it deleted. */
async function deleteMatching(t: TableClient, filter: string): Promise<number> {
  const keys: { partitionKey: string; rowKey: string }[] = [];
  for await (const e of t.listEntities<Entity>({ queryOptions: { filter, select: ['PartitionKey', 'RowKey'] } })) {
    keys.push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
  }
  let n = 0;
  for (const k of keys) if (await deleteRow(t, k.partitionKey, k.rowKey)) n += 1;
  return n;
}

/**
 * Remove a project and every row that exists because of it. Used only by the test cleanup route
 * (lib/testCleanup.ts), which decides whether the caller may; this does no checking of its own.
 *
 * What a project leaves in storage, and so what goes:
 *   pledges  every pledge, partitioned by project id
 *   claims   donors' pledge slots (partition = project id), the confirmation lock
 *            (confirm-<project id>), and the owner's receipt reservations naming this project
 *            (receipt-<owner id>, filtered on projectId)
 *   projects the project row and its owner index entry (owner-<owner id>)
 *
 * Nothing else holds a figure derived from a project: the home-page figures, the listing and the
 * sitemap are all computed from the project rows when they are read, so once the row is gone they
 * no longer count it. The children go first, so a request that fails part way leaves the project in
 * place and the same call can be made again to finish. The pledges and slots are swept once more
 * after the project row, for a pledge whose request read the project just before it went.
 */
export async function deleteProjectRecords(project: Pick<Project, 'id' | 'ownerId'>): Promise<{ pledges: number; claims: number }> {
  const [pledgesT, claimsT, projectsT] = await Promise.all([table('pledges'), table(CLAIMS_TABLE), table('projects')]);
  const id = project.id;
  let pledges = 0;
  let claims = 0;
  const sweepPledgesAndSlots = async () => {
    pledges += await deleteMatching(pledgesT, odata`PartitionKey eq ${id}`);
    claims += await deleteMatching(claimsT, odata`PartitionKey eq ${id}`);
  };
  await sweepPledgesAndSlots();
  if (await deleteRow(claimsT, `confirm-${id}`, 'lock')) claims += 1;
  claims += await deleteMatching(claimsT, odata`PartitionKey eq ${receiptPk(project.ownerId)} and projectId eq ${id}`);
  // The project row before its index entry: an index entry with no project row is skipped by every
  // reader, while a project row with no index entry would be a live project its owner's dashboard,
  // the open-project cap and profile deletion could no longer see.
  await deleteRow(projectsT, PROJECTS_PK, id);
  await deleteRow(projectsT, ownerIndexPk(project.ownerId), id);
  await sweepPledgesAndSlots();
  return { pledges, claims };
}

/** The donors' pledge slots on a project: which pledge holds each, and since when. */
export async function listPledgeSlots(projectId: string): Promise<{ donorId: string; pledgeId: string; createdAt: string }[]> {
  const out: { donorId: string; pledgeId: string; createdAt: string }[] = [];
  for await (const e of (await table(CLAIMS_TABLE)).listEntities<Entity>({ queryOptions: { filter: odata`PartitionKey eq ${projectId}` } })) {
    out.push({ donorId: e.rowKey, pledgeId: String(e.pledgeId ?? ''), createdAt: String(e.createdAt ?? '') });
  }
  return out;
}

/**
 * Whether a pledge request may still be running on a project, from its slots and pledge rows. A slot
 * is taken before the pledge row is written, so a recent slot with no row behind it, or one whose
 * row is still in flight, is a request in progress. Bounded by the same grace as everything else
 * here, so a request that died does not block for ever.
 */
export function pledgeRequestRunning(
  slots: { pledgeId: string; createdAt: string }[],
  pledges: Pledge[],
  asOf: number = Date.now(),
): boolean {
  if (pledges.some((p) => pledgeInFlight(p, asOf))) return true;
  const rows = new Map(pledges.map((p) => [p.id, p]));
  return slots.some((s) => {
    const since = Date.parse(s.createdAt);
    if (!Number.isFinite(since) || asOf - since > CLAIM_ORPHAN_GRACE_MS) return false;
    return !rows.has(s.pledgeId);
  });
}

// ---------- pledges ----------

/** A stored credit figure, or 0 when the column is missing or holds anything but a positive whole number. */
function storedCredits(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * The credits a pledge counts for once confirmed: what RIPE Atlas showed arriving when the owner
 * checked, otherwise what was pledged. Every total goes through this, so a manual pledge whose donor
 * sent a different amount is counted at what actually reached the project.
 */
export function creditedAmount(p: Pick<Pledge, 'amount' | 'receivedAmount'>): number {
  return p.receivedAmount > 0 ? p.receivedAmount : p.amount;
}

/** Exported for tests. */
export function toPledge(e: Entity): Pledge {
  return {
    id: e.rowKey,
    projectId: e.partitionKey,
    donorId: String(e.donorId ?? ''),
    donorName: String(e.donorName ?? ''),
    // Rows written before this field existed are not anonymous, which is what they were posted as.
    anonymous: e.anonymous === true,
    amount: Number(e.amount ?? 0),
    method: (e.method as PledgeMethod) ?? 'manual',
    status: (e.status as PledgeStatus) ?? 'pledged',
    transactionUrl: String(e.transactionUrl ?? ''),
    transactionId: String(e.transactionId ?? ''),
    transferredAt: String(e.transferredAt ?? ''),
    transferUncertain: e.transferUncertain === true,
    inFlight: e.inFlight === true,
    inFlightSince: String(e.inFlightSince ?? ''),
    // Rows written before these fields existed read as unchecked, which is what they were.
    receivedAmount: storedCredits(e.receivedAmount),
    amountVerified: e.amountVerified === true,
    message: String(e.message ?? ''),
    etag: typeof e.etag === 'string' ? e.etag : undefined,
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

/**
 * The name a retained row carries once its owner has deleted their profile.
 *
 * A constant, and stored rather than derived. Emptying the name instead would be worse than leaving it:
 * publicName falls back to `user-<first 6 of the account id>`, which is identical on every row the same
 * person ever touched, so every project and pledge of theirs would become linkable by a token anyone can
 * read. The public listing filters on the published owner name, so that token would also be a query key --
 * `?q=user-abc123` would enumerate one deleted account's projects from an unauthenticated endpoint. A value
 * shared by every deleted account cannot do either.
 *
 * It is stored rather than swapped in at read time because every read path would have to remember, and
 * because the promise is that the name is gone, not hidden. Deliberately not the `anonymous` flag on a
 * pledge: that records a choice its donor made while pledging, privatePledge deliberately shows the owner
 * through it, and this is a different fact about a different person's account.
 */
export const DELETED_ACCOUNT_NAME = 'Anonymous';

/**
 * Replace the display name this account left on the rows that outlive it.
 *
 * Deleting the profile removes the users row and nothing else, so every project and pledge keeps the name
 * that was copied onto it when it was written -- names are snapshots, and nothing joins these rows back to
 * the users table. Scrubbing them is therefore a point-in-time rewrite, with the same shape as the project
 * close beside it: best effort, per row, reporting what it actually did.
 *
 * Returns what it managed, not what it intended, so the caller can say so.
 *
 * A pledge whose transfer is in flight while this runs is safe: its request goes on writing the row after
 * the scrub, but savePledge never sends donorName (see pledgeWriteEntity), so those writes cannot put the
 * name back.
 */
export async function anonymizeRetainedNames(userId: string): Promise<{ projects: number; pledges: number; failed: number }> {
  let projects = 0;
  let pledges = 0;
  let failed = 0;

  // Every project, not only the open ones the close sweep looks at. A closed project keeps its card and its
  // page, so it keeps showing the name.
  for (const project of await listProjectsByOwner(userId)) {
    if (project.ownerName === DELETED_ACCOUNT_NAME) continue;
    try {
      // A merge, and updatedAt is preserved: this is not the owner editing their project, and moving it
      // would tell every reader the project had just changed.
      //
      // Conditional on the version this scan read, because preserving updatedAt means writing a value from
      // a snapshot. Unconditionally, a close or an owner edit landing between the scan and this write would
      // have its timestamp rolled back to the older one and the project would read as older than its last
      // real change. A 412 counts as unfinished rather than done, so the response says so and the next
      // deletion attempt picks it up.
      await patchProject(project.id, { ownerName: DELETED_ACCOUNT_NAME, updatedAt: project.updatedAt }, project.etag);
      projects += 1;
    } catch (err) {
      failed += 1;
      logError(`Could not anonymize the owner name on project ${project.id}`, err);
    }
  }

  // Pledges are partitioned by project, so this is a cross-partition scan. It is the expensive half and the
  // reason the caller treats the whole sweep as best effort.
  for (const pledge of await listPledgesByDonor(userId)) {
    if (pledge.donorName === DELETED_ACCOUNT_NAME) continue;
    try {
      await patchPledgeName(pledge.projectId, pledge.id, DELETED_ACCOUNT_NAME);
      pledges += 1;
    } catch (err) {
      failed += 1;
      logError(`Could not anonymize the donor name on pledge ${pledge.id}`, err);
    }
  }

  return { projects, pledges, failed };
}

/**
 * Merge just the donor name onto a pledge row. The only writer of donorName after creation.
 *
 * This sweep runs against rows other requests are actively settling, so it touches the one field it owns
 * and leaves the rest of the row to whoever owns that. savePledge is the mirror image: it writes the rest
 * and never the name.
 */
export async function patchPledgeName(projectId: string, id: string, donorName: string): Promise<void> {
  const t = await table('pledges');
  await t.updateEntity({ partitionKey: projectId, rowKey: id, donorName, updatedAt: now() } as TableEntity, 'Merge');
}

export async function listPledgesByDonor(donorId: string): Promise<Pledge[]> {
  const out: Pledge[] = [];
  for await (const e of (await table('pledges')).listEntities<Entity>({ queryOptions: { filter: odata`donorId eq ${donorId}` } })) {
    out.push(toPledge(e));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * How long after a confirmed manual pledge was last written its transfer could still be dated. A
 * row's date is when RIPE made the transfer, not when it was listed (seen live on dev: dated the
 * second the request was sent), so this is not about RIPE's indexing delay. It allows for an owner
 * who confirmed a little before the credits actually arrived, which nothing here can see.
 */
export const RECEIPT_INDEXING_SLACK_MS = 10 * 60 * 1000;

/**
 * Allowance for the clocks of this server and RIPE disagreeing, applied to an API transfer's
 * transferredAt: the moment this server saw RIPE accept it, so its row is dated no later than that.
 */
export const RECEIPT_CLOCK_SKEW_MS = 60 * 1000;

/** What a receipt check needs to know about the owner's other pledges. */
export interface ReceiptLedger {
  /** RIPE transaction ids already recorded against another pledge. */
  used: Set<string>;
  /** Other pledges that could own an arrival without having recorded which one. */
  rivals: { amount: number; from: number; until: number | null }[];
}

/**
 * Separate from the storage reads so the rules can be tested.
 *
 * `used` stops one recorded arrival being matched twice. `rivals` covers what `used` cannot see:
 * a pledge that owns an arrival without having recorded its id. That is every API transfer (the
 * server never looks its row up), every manual pledge confirmed without a check, and every pledge
 * still waiting, whose donor may already have sent. A rival can own an arrival of its own amount
 * recorded after it was created. A confirmed API transfer's row is dated no later than
 * transferredAt, when this server saw RIPE accept it, give or take the clocks. Any other confirmed
 * pledge's row is dated no later than shortly after it was last written, since its transfer had
 * happened by the time it was confirmed. updatedAt only moves forward (a later name scrub moves it
 * too), so that bound errs towards calling more rows contested, which only means the owner is asked
 * rather than a row being matched for them. transferredAt is used where it exists because a scrub
 * after a test run or a profile deletion would otherwise hold an API transfer's window open, and
 * every later arrival of that amount would be put to the owner (seen on dev).
 */
export function receiptLedger(pledges: Pledge[], exceptPledgeId: string): ReceiptLedger {
  const used = new Set<string>();
  const rivals: ReceiptLedger['rivals'] = [];
  for (const p of pledges) {
    if (p.id === exceptPledgeId || p.status === 'cancelled') continue;
    if (p.transactionId) used.add(p.transactionId);
    // A reference on a manual pledge was read from the owner's own log by a check, so it names the
    // owner's row and `used` covers it. One on an API pledge (none are written today, but the field
    // exists) would come from the donor's log, and the two rows of one transfer carry different ids
    // (seen live, docs/RIPE-ATLAS-NOTES.md), so an API pledge stays a rival either way.
    if (p.transactionId && p.method !== 'api') continue;
    const from = Date.parse(p.createdAt);
    if (!Number.isFinite(from)) continue;
    if (p.status === 'confirmed') {
      const accepted = p.method === 'api' ? Date.parse(p.transferredAt) : Number.NaN;
      const last = Date.parse(p.updatedAt);
      const until = Number.isFinite(accepted)
        ? accepted + RECEIPT_CLOCK_SKEW_MS
        : Number.isFinite(last)
          ? last + RECEIPT_INDEXING_SLACK_MS
          : null;
      rivals.push({ amount: creditedAmount(p), from, until });
    } else {
      rivals.push({ amount: p.amount, from, until: null });
    }
  }
  return { used, rivals };
}

/**
 * The receipt ledger across every project this owner has posted. One RIPE account receives the
 * credits for all of them, so an arrival has to be weighed against all of their pledges.
 *
 * Read before a check and not locked. Two confirmations racing each other can both find a row
 * unused, which is why the one that records it must also take reserveReceipt first.
 */
export async function ownerReceiptLedger(ownerId: string, exceptPledgeId: string): Promise<ReceiptLedger> {
  const projects = await listProjectsByOwner(ownerId);
  const all: Pledge[] = [];
  // Every project the owner ever posted, closed ones included, so in parallel batches: one partition
  // query each, the same bound the owner listing uses.
  for (let i = 0; i < projects.length; i += OWNER_READ_CONCURRENCY) {
    const batch = await Promise.all(projects.slice(i, i + OWNER_READ_CONCURRENCY).map((p) => listPledges(p.id)));
    for (const pledges of batch) all.push(...pledges);
  }
  return receiptLedger(all, exceptPledgeId);
}

/**
 * The partition holding one owner's receipt reservations, in the claims table. Pledge slots there
 * are partitioned by project id, which never starts with this prefix.
 */
function receiptPk(ownerId: string): string {
  return `receipt-${ownerId}`;
}

/**
 * Whether a held receipt reservation may be taken over by another pledge.
 *
 * The ledger above is read before the write, so on its own two confirmations of different pledges
 * could both see a transaction as unused and both record it: each pledge write is guarded by its
 * own version, and nothing spans the two. The reservation is one row per (owner, transaction),
 * created atomically before the pledge is saved, so only one of them gets it.
 *
 * It is released when the pledge write is refused, but a write whose outcome is unknown leaves it
 * behind, so it cannot be final on its own say-so. The pledge it names decides: confirmed with this
 * transaction means taken for good; anything else means the write never landed, and once the
 * reservation is older than any request could still be running it is free.
 */
export function receiptReservationReclaimable(heldCreatedAt: string, holder: Pledge | null, transactionId: string, asOf: number = Date.now()): boolean {
  if (holder && holder.status === 'confirmed' && holder.transactionId === transactionId) return false;
  const since = Date.parse(heldCreatedAt);
  if (!Number.isFinite(since)) return true;
  return asOf - since > CLAIM_ORPHAN_GRACE_MS;
}

/**
 * Reserve an arrival in the owner's RIPE Atlas log for one confirmation request. Returns a token
 * naming this request's reservation, or '' when another request holds it.
 *
 * Per request, not per pledge. Two requests confirming the same pledge at once would otherwise both
 * hold it, and the one whose pledge write then lost its 412 would release the winner's reservation,
 * leaving the recorded arrival free for a third request working from an older ledger. A reservation
 * held by another request, for whichever pledge, is respected until it is reclaimable.
 */
export async function reserveReceipt(ownerId: string, transactionId: string, projectId: string, pledgeId: string): Promise<string> {
  const t = await table(CLAIMS_TABLE);
  const token = newId();
  const entity = { partitionKey: receiptPk(ownerId), rowKey: transactionId, projectId, pledgeId, token, createdAt: now() };
  try {
    await t.createEntity(entity);
    return token;
  } catch (err) {
    if (!(err instanceof RestError && err.statusCode === 409)) throw err;
  }
  const held = await getEntity(CLAIMS_TABLE, receiptPk(ownerId), transactionId);
  if (!held) return reserveReceipt(ownerId, transactionId, projectId, pledgeId);
  const holder = await getPledge(String(held.projectId ?? ''), String(held.pledgeId ?? ''));
  if (!receiptReservationReclaimable(String(held.createdAt ?? ''), holder, transactionId)) return '';
  try {
    await t.updateEntity(entity, 'Replace', { etag: String(held.etag ?? '') });
    return token;
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 412 || err.statusCode === 404)) return '';
    throw err;
  }
}

/**
 * Whether a project's confirmation lock may be taken over. A holder is a request that is still
 * running or one that died; requests are bounded far below the orphan grace (a RIPE read gives up
 * after 5 seconds), so a lock older than that is a dead request's.
 */
export function confirmLockStale(heldCreatedAt: string, asOf: number = Date.now()): boolean {
  const since = Date.parse(heldCreatedAt);
  if (!Number.isFinite(since)) return true;
  return asOf - since > CLAIM_ORPHAN_GRACE_MS;
}

/**
 * One confirmation at a time per project, from reading the totals to writing the pledge.
 *
 * The ceiling check reads the project's confirmed total and then writes one pledge, and each pledge
 * write is guarded only by its own version, so two confirmations of different pledges could both
 * pass it and together take the project past its ceiling. A checked confirmation records what
 * arrived, which can be more than the pledge reserved, so that overshoot is not bounded by the
 * reservations. A row in the claims table, created atomically, serialises them.
 *
 * Waits briefly for a holder to finish, since the usual rival is the same owner's second click.
 * Returns a token for releaseConfirmLock, or '' when the lock stayed held.
 */
export async function acquireConfirmLock(projectId: string, waitMs = 8_000): Promise<string> {
  const t = await table(CLAIMS_TABLE);
  const pk = `confirm-${projectId}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = newId();
    const entity = { partitionKey: pk, rowKey: 'lock', token, createdAt: now() };
    try {
      await t.createEntity(entity);
      return token;
    } catch (err) {
      if (!(err instanceof RestError && err.statusCode === 409)) throw err;
    }
    const held = await getEntity(CLAIMS_TABLE, pk, 'lock');
    if (held && confirmLockStale(String(held.createdAt ?? ''))) {
      try {
        await t.updateEntity(entity, 'Replace', { etag: String(held.etag ?? '') });
        return token;
      } catch (err) {
        if (!(err instanceof RestError && (err.statusCode === 412 || err.statusCode === 404))) throw err;
      }
    }
    if (held && Date.now() >= deadline) return '';
    if (held) await new Promise((r) => setTimeout(r, 250));
  }
}

/** Release the project's confirmation lock, only if the request holding `token` still holds it. */
export async function releaseConfirmLock(projectId: string, token: string): Promise<void> {
  const pk = `confirm-${projectId}`;
  const held = await getEntity(CLAIMS_TABLE, pk, 'lock');
  if (!held || String(held.token ?? '') !== token) return;
  try {
    await (await table(CLAIMS_TABLE)).deleteEntity(pk, 'lock', { etag: String(held.etag ?? '') });
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 404 || err.statusCode === 412)) return;
    throw err;
  }
}

/** Whether a stored receipt reservation is the one the request holding `token` took. */
export function reservationHeldBy(row: Record<string, unknown> | null, token: string): boolean {
  return Boolean(row && token && String(row.token ?? '') === token);
}

/**
 * Prove a receipt reservation is still this request's and restart its grace, in one conditional
 * write. False when the row is gone, names another request, or changed under us (412).
 */
export async function renewReceipt(ownerId: string, transactionId: string, token: string): Promise<boolean> {
  const held = await getEntity(CLAIMS_TABLE, receiptPk(ownerId), transactionId);
  if (!held || !reservationHeldBy(held, token)) return false;
  try {
    await (await table(CLAIMS_TABLE)).updateEntity(
      { partitionKey: receiptPk(ownerId), rowKey: transactionId, createdAt: now() } as TableEntity,
      'Merge',
      { etag: String(held.etag ?? '') },
    );
    return true;
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 412 || err.statusCode === 404)) return false;
    throw err;
  }
}

/** Give a receipt reservation back, only if the request holding `token` still holds it. */
export async function releaseReceipt(ownerId: string, transactionId: string, token: string): Promise<void> {
  const held = await getEntity(CLAIMS_TABLE, receiptPk(ownerId), transactionId);
  if (!held || !reservationHeldBy(held, token)) return;
  try {
    await (await table(CLAIMS_TABLE)).deleteEntity(receiptPk(ownerId), transactionId, { etag: String(held.etag ?? '') });
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 404 || err.statusCode === 412)) return;
    throw err;
  }
}

export async function getPledge(projectId: string, id: string): Promise<Pledge | null> {
  const e = await getEntity('pledges', projectId, id);
  return e ? toPledge(e) : null;
}

/**
 * The single live-pledge slot a donor holds on a project.
 *
 * Reading the pledge list and then writing a row cannot enforce "one live pledge per donor":
 * a request that reads before a rival writes sees nothing to conflict with, and both proceed.
 * Sorting ids does not save it either, because two pledges created in the same millisecond are
 * ordered by a random suffix, so the rival can win and the first request has already gone ahead.
 * For a flow that moves credits irreversibly, that is a double transfer.
 *
 * Table Storage has no transaction spanning two rows, but creating one row IS atomic: exactly one
 * caller can create a given partition/row key and the rest get 409. That is the whole mechanism.
 * The row key is the donor id, so the slot is per (project, donor).
 */
const CLAIMS_TABLE = 'claims' as const;

/**
 * How long a slot with no pledge row behind it is still presumed to be a request in flight rather
 * than an orphan. The gap it covers is one table write plus, at worst, one RIPE call bounded by a
 * 20-second timeout. Two minutes is far wider than that, and the cost of being wrong in this
 * direction is only that a donor whose request died at exactly the wrong moment waits a little
 * before retrying, against a double transfer in the other.
 */
const CLAIM_ORPHAN_GRACE_MS = 2 * 60 * 1000;

/**
 * Take the slot. Returns false when another live pledge already holds it.
 *
 * A slot is reclaimable when the pledge behind it is no longer live, or when it has outlived the
 * reservation window. Reclaiming is itself conditional on the row's ETag, so if two requests both
 * decide a stale slot is free, only one takes it. Without that self-healing a release that failed
 * to run would lock a donor out of a project for ever.
 */
/**
 * Whether a held slot can be taken from its current owner. Separated from the storage call so the
 * rule can be tested: a slot is free once the pledge behind it has settled, and after the
 * reservation window regardless, which is what stops a release that never ran from locking a donor
 * out of a project permanently.
 */
/**
 * Whether a pledge's transfer attempt is still running. Bounded by the same grace a claim uses: a
 * request that died mid-transfer must not leave its row frozen for ever, and after the grace there
 * is nothing still in flight to protect.
 */
export function pledgeInFlight(p: Pledge, asOf: number = Date.now()): boolean {
  if (!p.inFlight) return false;
  // Measured from the moment the transfer was issued. Falling back to createdAt keeps rows written
  // before this field existed readable, and an unparseable value counts as in flight rather than
  // settled, because the failure that matters here is declaring a live transfer finished.
  const since = Date.parse(p.inFlightSince || p.createdAt);
  if (!Number.isFinite(since)) return true;
  return asOf - since <= CLAIM_ORPHAN_GRACE_MS;
}

/**
 * Whether a pledge may have used its project owner's RIPE address around the moment that owner deleted
 * their profile: an API transfer that may be sent to it, or a manual pledge whose donor may have been shown
 * it. Profile deletion reports these rather than promising the address is out of use (#20).
 *
 * Both pledge paths store their row before reading the owner, and deletion removes the owner before it
 * reads pledges, so any pledge that read the owner in time to use the address is already stored when
 * deletion looks. What has to be decided is only which stored rows are recent enough to matter. The same
 * grace as the in-flight window, measured from the moment each path committed to using the address: the
 * transfer marker for an API pledge, creation for a manual one.
 *
 * An API row with no inFlightSince never reached the marker, so it never read the owner for a transfer.
 * A cancelled API row sent nothing: it is cancelled only on a refusal or before the POST. A cancelled
 * manual row proves nothing, because its donor can be shown the address and cancel a moment later, so
 * recent manual rows count whatever their status.
 */
export function pledgeRacedDeletion(p: Pledge, deletedAt: number): boolean {
  if (p.method === 'api' && p.status === 'cancelled') return false;
  const started = Date.parse(p.method === 'api' ? p.inFlightSince : p.createdAt);
  if (!Number.isFinite(started)) return false;
  return started >= deletedAt - CLAIM_ORPHAN_GRACE_MS;
}

/**
 * Whether deletion has to look at a project's pledges for pledgeRacedDeletion. An open project, or one that
 * changed inside the window: a pledge only starts on a project it read as open, and a project closed since
 * then was written at the close. Everything else is closed and has been for longer than any pledge request
 * can run, so it is skipped rather than read.
 *
 * Measured by the storage timestamp, not updatedAt. An operator's takedown is a hand-made merge that leaves
 * updatedAt alone, so a project closed that way a second ago would otherwise read as long closed.
 */
export function projectMayHaveRacedDeletion(p: Project, deletedAt: number): boolean {
  if (p.status === 'open') return true;
  const changed = Date.parse(p.storedAt || p.updatedAt);
  return !Number.isFinite(changed) || changed >= deletedAt - CLAIM_ORPHAN_GRACE_MS;
}

/**
 * Whether a pledge is unresolved rather than merely pending: the transfer was issued, RIPE never gave a
 * usable answer, and nobody has established whether the credits moved.
 *
 * The reservation expiry answers "has this donor abandoned their reservation?", and for that question age is
 * real evidence. These rows pose a different question -- "did the credits move?" -- and age is no evidence
 * about it whatever. Fourteen days of silence says nothing about whether a POST that timed out was processed
 * at RIPE. One cutoff was serving both questions, so the second was being answered by default in the
 * direction that sends the same credits twice.
 *
 * The status conjunct is load-bearing rather than defensive. transferUncertain is never cleared when a
 * pledge is settled -- pledges-update writes `{ ...pledge, status }` -- so a confirmed row still carries the
 * flag, and keying on it alone would hold that row's slot and its reservation for ever.
 */
export function pledgeUnresolved(p: Pledge): boolean {
  return p.transferUncertain && (p.status === 'pledged' || p.status === 'sent');
}

/**
 * Whether a donor may withdraw their own API pledge.
 *
 * Normally they may not: once a transfer has been issued, cancelling frees the donor's slot, and if RIPE did
 * complete it the next pledge sends the same credits again. Only the owner can say whether they arrived.
 *
 * The exception is a row that provably never reached the POST, which exists when the pledge was written and
 * then the balance check or the recipient read failed. Holding its donor to the owner-only rule strands them
 * behind a pledge they cannot clear and the owner has no reason to look at.
 *
 * `inFlight` is what makes the proof sound, and an empty `inFlightSince` on its own would not be. toPledge
 * fills every absent field with a default, so a row written before `inFlightSince` existed also reads empty
 * -- and such a row may well have transferred. But those rows predate `inFlight` too, so they read false,
 * while every API pledge written by current code is created with it true. Requiring true therefore admits
 * only rows this code wrote, which are the only ones whose empty marker means what it says.
 */
export function donorMayCancelApiPledge(p: Pledge, asOf: number = Date.now()): boolean {
  // The in-flight window is part of the rule, not a separate concern. pledges-update refuses any action on
  // an in-flight pledge before it reaches the guard this predicate backs, so leaving it out here offered a
  // Cancel button on exactly the rows the handler rejects -- a fresh API pledge, in the seconds between its
  // row being written and the grace window lapsing. That is the mismatch this predicate was extracted to
  // end, reappearing one condition further in.
  if (pledgeInFlight(p, asOf)) return false;
  return p.status === 'pledged' && p.inFlight === true && !p.inFlightSince;
}

export function claimIsReclaimable(heldCreatedAt: string, pledge: Pledge | null, asOf: number = Date.now()): boolean {
  // The row comes first, before anything derived from the clock. This is the one site of the four that had
  // to be reordered rather than extended, and it has two clock-based exits, not one: the age check, and the
  // unreadable-timestamp fallback above it. Either would hand away an unresolved pledge's slot without ever
  // looking at the pledge -- and a claim whose own createdAt is malformed is exactly the row least worth
  // trusting a clock about. Asking the row first is behaviour-preserving for every other input: an old
  // pledged or sent row, an old settled row and an old orphan all still reclaim as before.
  if (pledge && pledgeUnresolved(pledge)) return false;
  if (pledge && pledge.status !== 'pledged' && pledge.status !== 'sent') return true;
  const heldSince = Date.parse(heldCreatedAt);
  if (!Number.isFinite(heldSince)) return true;
  const age = asOf - heldSince;
  if (age > PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000) return true;
  if (!pledge) {
    // A slot with no pledge behind it is almost always a request still in flight: the slot is
    // taken first, and only then is the row written. Calling that free would hand a rival the
    // slot inside that gap, and both would go on to transfer, which is the exact failure the
    // slot exists to prevent. So a pledgeless slot counts as held until enough time has passed
    // that no request could still be inside the window, generously longer than the 20-second
    // RIPE timeout that bounds it.
    return age > CLAIM_ORPHAN_GRACE_MS;
  }
  return pledge.status !== 'pledged' && pledge.status !== 'sent';
}

export async function acquirePledgeClaim(projectId: string, donorId: string, pledgeId: string): Promise<boolean> {
  const t = await table(CLAIMS_TABLE);
  const entity = { partitionKey: projectId, rowKey: donorId, pledgeId, createdAt: now() };
  try {
    await t.createEntity(entity);
    return true;
  } catch (err) {
    if (!(err instanceof RestError && err.statusCode === 409)) throw err;
  }

  const held = await getEntity(CLAIMS_TABLE, projectId, donorId);
  if (!held) return acquirePledgeClaim(projectId, donorId, pledgeId);

  const pledge = await getPledge(projectId, String(held.pledgeId ?? ''));
  if (!claimIsReclaimable(String(held.createdAt ?? ''), pledge)) return false;

  try {
    await t.updateEntity(entity, 'Replace', { etag: String(held.etag ?? '') });
    return true;
  } catch (err) {
    // 412 means somebody else reclaimed it between our read and our write. They won.
    if (err instanceof RestError && (err.statusCode === 412 || err.statusCode === 404)) return false;
    throw err;
  }
}

/** Give the slot back. Safe to call when it is not held, and when it is held by someone else. */
export async function releasePledgeClaim(projectId: string, donorId: string, pledgeId: string): Promise<void> {
  const held = await getEntity(CLAIMS_TABLE, projectId, donorId);
  if (!held || String(held.pledgeId ?? '') !== pledgeId) return;
  try {
    await (await table(CLAIMS_TABLE)).deleteEntity(projectId, donorId, { etag: String(held.etag ?? '') });
  } catch (err) {
    if (err instanceof RestError && (err.statusCode === 404 || err.statusCode === 412)) return;
    throw err;
  }
}

export async function createPledge(p: Pledge): Promise<Pledge> {
  // Keep the version the create returned. Without it every later conditional write on this row
  // would be handed undefined and silently fall back to an unconditional one, which is a guard
  // that reads as present and does nothing.
  const res = await (await table('pledges')).createEntity({ partitionKey: p.projectId, rowKey: p.id, ...p });
  return { ...p, etag: res.etag };
}

/**
 * The row a pledge write sends: every field this request owns, and never donorName.
 *
 * Separated so the omission can be tested, because the whole fix is an absence. donorName is written
 * once, by createPledge, and after that only by the deletion sweep through patchPledgeName. Every other
 * write is a request settling a pledge it holds in memory, and that copy of the name was taken when the
 * request started. Sending it back put the name on a row the sweep had just scrubbed (#33): the sweep
 * counted the row as done, the profile page told the person their name was gone, and a transfer that
 * finished seconds later wrote it back. A writer that never sends the field cannot lose that update.
 *
 * Paired with a merge rather than a replace, since a replace would clear the omitted column instead of
 * leaving it alone. Nothing here depended on a replace clearing anything: every Pledge field is always
 * present on the object, so each one is written explicitly, empty strings included.
 */
export function pledgeWriteEntity(p: Pledge): Record<string, unknown> {
  const { donorName: _donorName, etag: _etag, ...owned } = p;
  return { partitionKey: p.projectId, rowKey: p.id, ...owned };
}

export async function savePledge(p: Pledge, ifMatch?: string): Promise<Pledge> {
  const updated = { ...p, updatedAt: now() };
  const entity = pledgeWriteEntity(updated);
  const t = await table('pledges');
  // With ifMatch this is a conditional merge: it fails with 412 if the row changed since the
  // caller read it, which is how two people acting on the same pledge stop overwriting each other.
  //
  // The returned etag is the new row version, and callers that write the same pledge more than
  // once must carry it forward. Not doing so was worse than having no guard at all: a later
  // conditional write still held the version from the create, so it failed with 412 every single
  // time, and the cancellation it was guarding simply never happened.
  //
  // Both calls resolve to a response carrying the new etag. Worth stating, because review has
  // twice read this as returning void: that is TableTransaction.updateEntity, the batch builder,
  // which queues an operation and has nothing to return. TableClient.updateEntity resolves to
  // TableUpdateEntityHeaders. Verified against the service rather than the types, since the field
  // is declared optional: the etag comes back populated, differs on every write, and the previous
  // one is rejected with 412 afterwards.
  const res = ifMatch
    ? await t.updateEntity(entity as TableEntity, 'Merge', { etag: ifMatch })
    : await t.upsertEntity(entity as TableEntity, 'Merge');
  return { ...updated, etag: res.etag };
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
      confirmed += creditedAmount(p);
    } else if (p.status === 'pledged' || p.status === 'sent') {
      // An unresolved row keeps its reservation at any age. It is also what keeps the owner being told
      // something is waiting: the dashboard's prompt and the refresh rotation that keeps it accurate are
      // both derived from creditsPending, so releasing the capacity would silence the only signal that
      // gets these settled.
      if (pledgeUnresolved(p)) { pending += p.amount; continue; }
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
/**
 * Whether a pending pledge still holds its reservation. Expiry is a read-time rule rather than a
 * stored status, because there is no timer to write one, so every path that treats a pledge as
 * live has to apply it.
 */
export function pledgeExpired(p: Pledge, asOf: number = Date.now()): boolean {
  if (p.status !== 'pledged' && p.status !== 'sent') return false;
  // Unreachable for these rows today -- the only caller guards the transition to `sent`, which an already
  // sent row cannot take -- but the rule belongs in the predicate rather than depending on that staying true.
  if (pledgeUnresolved(p)) return false;
  const created = Date.parse(p.createdAt);
  if (!Number.isFinite(created)) return false;
  return created < asOf - PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000;
}

export function activePledgesBy(pledges: Pledge[], donorId: string, asOf: number = Date.now()): Pledge[] {
  const cutoff = asOf - PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000;
  return pledges.filter((p) => {
    if (p.donorId !== donorId) return false;
    if (p.status !== 'pledged' && p.status !== 'sent') return false;
    // Holds the donor's single live-pledge slot for as long as it is unresolved. This is the site the
    // duplicate transfer actually came through: with the row aged out, the donor could open a second pledge
    // on the same project and send the credits again.
    if (pledgeUnresolved(p)) return true;
    const created = Date.parse(p.createdAt);
    return !Number.isFinite(created) || created >= cutoff;
  });
}

/** Recompute cached totals on the project from its pledges. */
/**
 * Rewrite a project's cached credit totals from its pledges.
 *
 * Two pledge writes finishing at once would otherwise each compute totals from their own snapshot
 * and write unconditionally, so whichever landed last would win with a figure that omitted the
 * other's pledge. Nothing later repairs that: the cached total is only rebuilt by another pledge
 * write, so a project could sit permanently under-counted. The write is therefore conditional on
 * the row not having changed since it was read, and a conflict means recompute and try again,
 * which converges because the totals are derived from the pledges rather than from the old value.
 */
export async function recomputeProjectTotals(projectId: string, attempts = 5): Promise<Project> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const project = await getProject(projectId);
    if (!project) notFound();
    const t = totals(await listPledges(projectId));
    if (project.creditsConfirmed === t.confirmed && project.creditsPending === t.pending) return project;
    try {
      return await patchProject(projectId, { creditsConfirmed: t.confirmed, creditsPending: t.pending }, project.etag);
    } catch (err) {
      if (!(err instanceof RestError && err.statusCode === 412)) throw err;
      last = err;
    }
  }
  throw last instanceof Error ? last : new HttpError(409, 'Could not update project totals');
}

export { now };
