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

function client(table: 'users' | 'projects' | 'pledges' | 'claims'): TableClient {
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
      for (const t of ['users', 'projects', 'pledges', 'claims'] as const) {
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

export function claimIsReclaimable(heldCreatedAt: string, pledge: Pledge | null, asOf: number = Date.now()): boolean {
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

export async function savePledge(p: Pledge, ifMatch?: string): Promise<Pledge> {
  const updated = { ...p, updatedAt: now() };
  const entity = { partitionKey: p.projectId, rowKey: p.id, ...updated };
  const t = await table('pledges');
  // With ifMatch this is a conditional replace: it fails with 412 if the row changed since the
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
    ? await t.updateEntity(entity as TableEntity, 'Replace', { etag: ifMatch })
    : await t.upsertEntity(entity, 'Replace');
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
/**
 * Whether a pending pledge still holds its reservation. Expiry is a read-time rule rather than a
 * stored status, because there is no timer to write one, so every path that treats a pledge as
 * live has to apply it.
 */
export function pledgeExpired(p: Pledge, asOf: number = Date.now()): boolean {
  if (p.status !== 'pledged' && p.status !== 'sent') return false;
  const created = Date.parse(p.createdAt);
  if (!Number.isFinite(created)) return false;
  return created < asOf - PENDING_RESERVATION_DAYS * 24 * 60 * 60 * 1000;
}

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
