import { app, HttpRequest } from '@azure/functions';
import { getPrincipal, requirePrincipal } from '../lib/auth';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Project, acquireConfirmLock, acquireProjectPostWindow, createProject, ensureUser, getProject, getUser, listOpenProjectsByOwner, listPledges, listProjects, nextResultsPostedAt, now, patchProject, releaseConfirmLock, totals } from '../lib/store';
import { MAX_OPEN_PROJECTS_PER_USER, PROJECT_POST_INTERVAL_MS, SurplusClose, capSettlement, surplusOpenProjects } from '../lib/pledging';
import { httpsUrl, int, isoDate, MAX_CREDITS, oneOf, str, tags } from '../lib/validate';
import { isPublicProject, publicPledge, publicProject, publicUser } from '../lib/views';
import { projectHead } from '../lib/projectHtml';
import { logError } from '../lib/telemetry';

/**
 * How many projects one listing will re-read pledges for. Anything above this keeps its cached
 * totals for that request; the write-back means a stale project needs correcting only once, so
 * the backlog drains across a few listings rather than being rescanned on every one.
 */
const STALE_REFRESH_LIMIT = 20;

app.http('projects-list', {
  route: 'projects',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const status = req.query.get('status') ?? 'open';
    const tag = req.query.get('tag') ?? '';
    const q = (req.query.get('q') ?? '').trim().toLowerCase();
    const sort = req.query.get('sort') ?? 'newest';

    // Read-time expiry has to reach the listing too, or an abandoned reservation shows as reserved
    // on every card for ever and the project keeps advertising a maxPledge of 0. Only a project
    // that currently shows reserved credits can be stale, and the cached total is rewritten on
    // every pledge write, so a cached pending of 0 is trustworthy.
    //
    // Two things keep that from turning an anonymous request into unbounded table work. The fan-out
    // is capped, so a large number of stale projects cannot be used to amplify one request. And a
    // correction is written back, so each stale project is re-read once and then drops out of the
    // fan-out for good, instead of being rescanned on every listing until somebody pledges to it.
    const rows = await listProjects();
    // Least recently checked first. Taking the newest N would starve the rest: a project with a
    // genuinely live reservation never leaves that prefix, so it would be rescanned on every
    // listing while an expired reservation on an older project was never looked at again. The
    // ordering runs off totalsCheckedAt, which this refresh always advances, rather than off
    // updatedAt, which belongs to the project's own history and must not move for maintenance.
    const checked = (x: Project): string => x.totalsCheckedAt ?? '';
    const stale = rows
      .filter((p) => p.creditsPending > 0 || p.totalsDirty)
      .sort((a, b) => (checked(a) < checked(b) ? -1 : checked(a) > checked(b) ? 1 : 0))
      .slice(0, STALE_REFRESH_LIMIT);
    // Every one of these is optional maintenance, and the listing is the most public thing the
    // site serves. Only the corrective write was best effort: a transient failure from any of the
    // pledge scans rejected the Promise.all and turned the whole anonymous listing into a 500, so
    // a home-page refresh added up to twenty ways for the front page to go down. Each project now
    // settles independently and falls back to its cached totals.
    const live = new Map<string, { confirmed: number; pending: number }>();
    await Promise.all(stale.map(async (p) => {
      let t: { confirmed: number; pending: number };
      try {
        t = totals(await listPledges(p.id));
      } catch (err) {
        logError(`Could not refresh totals for project ${p.id}`, err);
        // Rotate it even though the scan failed. Candidates are ordered least-recently-checked
        // first, so a project whose scan keeps failing stays at the head of that order and is
        // picked again on every single request, spending one of the refresh slots for ever and
        // starving the projects behind it. Advancing the timestamp alone moves it to the back of
        // the queue; totalsDirty is left set, so it stays a candidate and is retried in turn
        // rather than abandoned. Best effort: this is maintenance about maintenance.
        await patchProject(p.id, { totalsCheckedAt: now(), updatedAt: p.updatedAt }, p.etag).catch(() => undefined);
        return;
      }
      live.set(p.id, t);
      // Write back either way. When the totals differ this corrects them; when they match it still
      // moves updatedAt, which is what lets the next listing look at a different set of projects
      // instead of the same prefix for ever.
      //
      // Conditional on the version this request selected. A pledge created or confirmed since the
      // read above has already recomputed these totals, and overwriting that with the older figure
      // would be worse than doing nothing: writing creditsPending back to 0 also drops the project
      // out of future refreshes, so the stale value would never be corrected. A 412 means somebody
      // else has just done this work, which is the outcome we wanted anyway. Best effort besides:
      // a listing must not fail because a correction could not be persisted.
      await patchProject(
        p.id,
        {
          creditsConfirmed: t.confirmed,
          creditsPending: t.pending,
          totalsCheckedAt: now(), totalsDirty: false,
          // Always preserved, correcting or not. This runs on anonymous listing traffic, and
          // expiring a reservation is bookkeeping rather than something the owner did, so moving
          // updatedAt would tell every reader the project had just been edited. Rotation runs off
          // totalsCheckedAt precisely so that updatedAt can stay the project's own history.
          updatedAt: p.updatedAt,
        },
        p.etag,
      ).catch(() => undefined);
    }));
    // A project an operator took down is off every listing, as it is off the sitemap and its page.
    let projects = rows.filter(isPublicProject).map((p) => publicProject(p, live.get(p.id)));
    if (status === 'open') projects = projects.filter((p) => p.open);
    else if (status === 'funded') projects = projects.filter((p) => p.funded);
    else if (status === 'closed') projects = projects.filter((p) => p.status === 'closed');
    // Filtered on the derived flag rather than on the summary text, for the same reason the stats
    // count it that way: whether a project reported is a fact about the row's history, not about
    // how much text happens to be in it right now.
    else if (status === 'results') projects = projects.filter((p) => p.hasResults);
    if (tag) projects = projects.filter((p) => (p.tags as string[]).includes(tag));
    if (q) projects = projects.filter((p) => `${p.title} ${p.summary} ${p.affiliation} ${p.ownerName}`.toLowerCase().includes(q));
    if (sort === 'need') projects.sort((a, b) => b.remaining - a.remaining);
    else if (sort === 'deadline') projects.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    else if (sort === 'progress') projects.sort((a, b) => b.creditsConfirmed / b.creditsRequested - a.creditsConfirmed / a.creditsRequested);

    return json({ projects }, 200, { 'cache-control': 'public, max-age=15' });
  }),
});

app.http('projects-get', {
  route: 'projects/{id}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    const principal = getPrincipal(req);
    // A project an operator took down answers 404 like its page does, except to its owner, who can
    // still open it and settle its pledges.
    if (!project || (!isPublicProject(project) && principal?.userId !== project.ownerId)) throw new HttpError(404, 'Not found');
    const [owner, pledges] = await Promise.all([getUser(project.ownerId), listPledges(id)]);
    // The pledges are already loaded here, so use expiry-aware totals rather than the cached
    // counters: a lapsed reservation is released on reads too, not only after the next write.
    const live = totals(pledges);
    return json({
      project: publicProject(project, live),
      owner: owner ? publicUser(owner) : null,
      pledges: pledges.filter((p) => p.status !== 'cancelled').map(publicPledge),
      viewer: principal ? { isOwner: principal.userId === project.ownerId, userId: principal.userId } : null,
      // The title and description the server-rendered page carries, so the app sets the same head.
      page: projectHead(project),
    });
  }),
});

function readProjectFields(body: Record<string, unknown>, required: boolean): Partial<Project> {
  const out: Partial<Project> = {};
  const title = str(body, 'title', { max: 120, required });
  if (title !== undefined) out.title = title;
  const summary = str(body, 'summary', { max: 280, required });
  if (summary !== undefined) out.summary = summary;
  const description = str(body, 'description', { max: 8000, required });
  if (description !== undefined) out.description = description;
  const creditsRequested = int(body, 'creditsRequested', { min: 1, max: MAX_CREDITS, required });
  if (creditsRequested !== undefined) out.creditsRequested = creditsRequested;
  const t = tags(body);
  if (t !== undefined) out.tags = t;
  const affiliation = str(body, 'affiliation', { max: 120 });
  if (affiliation !== undefined) out.affiliation = affiliation;
  // Half the length of description: this is what came out, not the proposal again, and the whole
  // row is served in full on the anonymous listing, which has no select projection yet (#19).
  const resultsSummary = str(body, 'resultsSummary', { max: 4000 });
  if (resultsSummary !== undefined) out.resultsSummary = resultsSummary;
  for (const key of ['homepageUrl', 'repoUrl', 'paperUrl', 'resultsUrl'] as const) {
    const v = httpsUrl(body, key);
    if (v !== undefined) out[key] = v;
  }
  const deadline = isoDate(body, 'deadline');
  if (deadline !== undefined) out.deadline = deadline;
  return out;
}

/**
 * Bring an owner back under the open-project cap after a write that may have breached it.
 *
 * A count read before writing cannot enforce a limit: concurrent creates, concurrent reopens, and
 * an edit form that submits status "open" on every save can each pass the check and then all
 * write. Settling afterwards works because every racer re-reads and sees the others, and ids are
 * time-prefixed so they all pick the same surplus set.
 *
 * Closing a surplus row is best effort. Failing here after the row is already written would leave
 * the account over the cap AND fail the request, and the next write settles it again anyway. What
 * the caller gets back is therefore read from the rows, never from the set this meant to close:
 * the two agree only when every write landed, which is exactly what the best-effort catch gives
 * up. See capSettlement for what shipped when they were treated as the same thing.
 */
async function settleOpenProjectCap(ownerId: string, ownId: string): Promise<{ ownClosed: boolean; unclosed: number }> {
  const surplus = surplusOpenProjects(await listOpenProjectsByOwner(ownerId), MAX_OPEN_PROJECTS_PER_USER);
  const closes: SurplusClose[] = [];
  for (const extra of surplus) {
    // Only the status: these rows were read a moment ago and a pledge recompute or an owner edit
    // may have landed since, so writing a whole snapshot back would revert it.
    let after: Project | null;
    try {
      after = await patchProject(extra.id, { status: 'closed' });
    } catch (err) {
      logError(`Could not close surplus project ${extra.id}`, err);
      // Ask storage what is stored rather than reading the throw as "the row is untouched". A
      // merge that failed on the way back has still applied, and this is the same rule the pledge
      // path settled on: read the row, not the exception.
      after = await getProject(extra.id).catch(() => null);
    }
    closes.push({ id: extra.id, closed: after?.status === 'closed' });
  }
  return capSettlement(closes, ownId);
}

/** One line for the log when the settlement left an account over the cap. */
function overCapNote(unclosed: number): string {
  return `Open-project cap: ${unclosed} surplus project(s) could not be closed, so this account is over the cap until its next create or reopen settles them.`;
}

app.http('projects-create', {
  route: 'projects',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const user = await ensureUser(p.userId, p.identityProvider, p.userDetails);
    if (!user.atlasEmail) throw new HttpError(409, 'Add your RIPE NCC Access email to your profile before posting a project');

    // No preflight count here. The settlement after the write is what enforces the cap, because a
    // count read before writing cannot, and running both doubled an owner scan on every post for
    // an answer the settlement reaches anyway.

    const body = await readJson(req);
    const fields = readProjectFields(body, true);

    // Take the posting window before writing the row, and after validating the body so that a
    // rejected draft does not spend it.
    //
    // The cap below limits open projects, not rows, and it closes the surplus itself, so a loop of
    // POSTs needs no close step to leave a permanent row per request. Nothing prunes those rows.
    // Owner lookups are keyed, so they only slow down the account that posted them, but every row
    // is still served on the anonymous listing. This is a rate, not a total: it does not shrink a
    // table already grown, and pruning closed projects is still the only thing that would.
    //
    // Held as a row rather than checked as a count, for the reason the pledge claim spells out and
    // this very cap had to learn twice: a burst of concurrent posts all read the old stamp before
    // any of them writes, and all proceed.
    //
    // A post the cap refuses below has still spent the window, so an owner who frees a slot and
    // reposts at once may wait the interval out. Giving the window back on refusal would add a
    // release that can itself fail, for a case where the owner has something to do first anyway.
    if (!(await acquireProjectPostWindow(user.id, PROJECT_POST_INTERVAL_MS))) {
      throw new HttpError(429, `Projects can be posted once every ${Math.round(PROJECT_POST_INTERVAL_MS / 1000)} seconds per account. Try again shortly.`);
    }

    const ts = now();
    const project: Project = {
      id: newId(),
      ownerId: user.id,
      ownerName: user.displayName || user.handle,
      title: fields.title!,
      summary: fields.summary!,
      description: fields.description!,
      creditsRequested: fields.creditsRequested!,
      creditsConfirmed: 0,
      creditsPending: 0,
      status: 'open',
      tags: fields.tags ?? [],
      affiliation: fields.affiliation ?? user.affiliation ?? '',
      homepageUrl: fields.homepageUrl ?? '',
      repoUrl: fields.repoUrl ?? '',
      paperUrl: fields.paperUrl ?? '',
      deadline: fields.deadline ?? '',
      resultsSummary: fields.resultsSummary ?? '',
      resultsUrl: fields.resultsUrl ?? '',
      // The form does not offer these until the project exists, but the route accepts them, and a
      // write-up rendering on the page while hasResults stayed false would put the project page
      // and the listing filter into open disagreement. Same rule as the edit path, one call.
      resultsPostedAt: nextResultsPostedAt('', fields, ts),
      moderationClosed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await createProject(project);

    // The owner may have deleted their profile while this request was in flight. Deletion closes
    // open projects, but it can only close the ones its sweep can see, so a project written after
    // that sweep would survive as an open project with nobody able to receive credits for it.
    // Checking after the write closes the gap from this side: either deletion sees this row and
    // closes it, or this sees the missing user row and closes itself. One always holds, because
    // both read after writing.
    if (!(await getUser(user.id))?.atlasEmail) {
      await patchProject(project.id, { status: 'closed' }).catch(() => undefined);
      throw new HttpError(409, 'Your profile is no longer available, so this project was not published.');
    }

    // Nothing before this write could have enforced the cap: simultaneous requests can all pass a
    // count read before writing. Settle it now the row is visible: re-read, and if this owner is
    // over the cap, the newest projects close themselves back down to it. Ids are time-prefixed, so
    // the newest row always sees every older one and every racer reaches the same verdict without
    // coordination. Unlike a transfer, nothing irreversible has happened, so closing is a complete
    // remedy.
    //
    // Refuse only when this project was really closed. If its close failed, the row is open and
    // publicly listed, and 201 is the true answer: telling the owner their post was refused while
    // the site serves it leaves them with no id, no link, and a project they do not know they have.
    // The account then sits one over a soft anti-spam limit of three until its next create or
    // reopen re-derives the surplus, which costs nobody anything visible.
    const settled = await settleOpenProjectCap(user.id, project.id);
    if (settled.ownClosed) {
      throw new HttpError(409, `You already have ${MAX_OPEN_PROJECTS_PER_USER} open projects. Close one before posting another.`);
    }
    if (settled.unclosed > 0) logError(overCapNote(settled.unclosed));

    return json({ project: publicProject(project) }, 201);
  }),
});

app.http('projects-update', {
  route: 'projects/{id}',
  methods: ['PATCH'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'Not found');
    if (project.ownerId !== p.userId) throw new HttpError(403, 'Only the project owner can edit it');
    const body = await readJson(req);
    const fields = readProjectFields(body, false);
    const status = oneOf(body, 'status', ['open', 'closed'] as const);

    // Reopening has to clear every bar that posting clears, and one more besides.
    if (status === 'open' && project.status !== 'open') {
      // A takedown has to survive the owner. Without this, closing a reported project is undone by
      // its owner from any stale edit form, and the remedy in SECURITY.md is not a remedy at all.
      if (project.moderationClosed) {
        throw new HttpError(403, 'This project was closed by the site and cannot be reopened. Contact the maintainer if you think that was a mistake.');
      }
      // Deleting a profile closes its projects but leaves them on the site, and signing in again
      // recreates the profile with no RIPE address. Without this an owner could reopen a project
      // that lists publicly and fails every pledge, because there would be no recipient to name.
      const owner = await getUser(p.userId);
      if (!owner?.atlasEmail) {
        throw new HttpError(409, 'Add your RIPE NCC Access email to your profile before reopening a project; donors cannot send credits without it');
      }
      // Reopening is another way past the cap, and it is enforced by the same post-write
      // settlement rather than a count here, for the same reason.
    }

    // Stamped from the row this request already read, and only when it actually changes, so an
    // ordinary edit does not rewrite a column it has nothing to say about. nextResultsPostedAt
    // holds the write-once rule; see it for why two racing PATCHes need no conditional write here.
    const resultsPostedAt = nextResultsPostedAt(project.resultsPostedAt, fields, now());

    // Merge rather than replace, and never send moderationClosed. An owner edit built on a row
    // read before an operator set the flag would otherwise write the takedown away, along with any
    // credit totals a pledge recompute changed in between. The check above stops a deliberate
    // reopen; this stops an accidental one.
    // A change to the request moves the project's ceiling, which a confirmation checks and writes
    // against under the project's confirmation lock. Taking the same lock here means a confirmation
    // never records against a ceiling that changed between its check and its write.
    const ceilingChanges = fields.creditsRequested !== undefined && fields.creditsRequested !== project.creditsRequested;
    const lockToken = ceilingChanges ? await acquireConfirmLock(id) : '';
    if (ceilingChanges && !lockToken) {
      throw new HttpError(409, 'A pledge on this project is being confirmed right now. Your changes were not saved. Try again in a moment.');
    }
    let updated: Project;
    try {
      updated = await patchProject(id, {
        ...fields,
        ...(status ? { status } : {}),
        ...(resultsPostedAt !== project.resultsPostedAt ? { resultsPostedAt } : {}),
      });
    } finally {
      if (lockToken) await releaseConfirmLock(id, lockToken).catch(() => undefined);
    }

    // The flag can be set between the read above and this write, so re-check what actually landed
    // and put the project back if a takedown arrived while the edit was in flight.
    if (updated.moderationClosed && updated.status === 'open') {
      const restored = await patchProject(id, { status: 'closed' });
      return json({ project: publicProject(restored) });
    }

    // Same check as creation, for the same reason: the profile can be deleted between the guard
    // above and this write, and deletion's sweep may already have passed this row.
    if (updated.status === 'open' && !(await getUser(p.userId))?.atlasEmail) {
      const reclosed = await patchProject(id, { status: 'closed' });
      return json({ project: publicProject(reclosed) });
    }

    // Settle the cap after any write that leaves this project open, exactly as creation does. The
    // count check above reads before writing, so two reopens can both pass it, and the edit form
    // submits status "open" on every save, which can reopen a row the creation settlement had just
    // closed. Neither is caught by a preflight; both are caught here.
    if (updated.status === 'open') {
      const settled = await settleOpenProjectCap(p.userId, id);
      if (settled.unclosed > 0) logError(overCapNote(settled.unclosed));
      // Answer from the row either way. This path already did: it re-read after settling rather
      // than describing what it had planned, which is the shape the create path was missing.
      if (settled.ownClosed) return json({ project: publicProject((await getProject(id)) ?? updated) });
    }

    return json({ project: publicProject(updated) });
  }),
});
