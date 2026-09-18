import { app, HttpRequest } from '@azure/functions';
import { RestError } from '@azure/data-tables';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, AtlasRefused, AtlasUnreachable, findTransferTransaction, getCredits, transferCredits } from '../lib/atlas';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Pledge, Project, acquirePledgeClaim, activePledgesBy, createPledge, ensureUser, getPledge, getProject, getUser, listPledges, now, pledgeExpired, pledgeInFlight, recomputeProjectTotals, releasePledgeClaim, savePledge, totals } from '../lib/store';
import { int, MAX_CREDITS, oneOf, str } from '../lib/validate';
import { OVERFUND_MULTIPLIER, PENDING_RESERVATION_DAYS, acceptsMorePledges, capacity, maxCredits, maxSinglePledge } from '../lib/pledging';
import { privatePledge, publicProject } from '../lib/views';

app.http('pledges-list', {
  route: 'projects/{id}/pledges',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'Not found');
    const all = await listPledges(id);
    const visible = project.ownerId === p.userId ? all : all.filter((x) => x.donorId === p.userId);
    return json({ pledges: visible.map(privatePledge), isOwner: project.ownerId === p.userId });
  }),
});

app.http('pledges-create', {
  route: 'projects/{id}/pledges',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const principal = requirePrincipal(req);
    const id = req.params.id;
    if (!isId(id)) throw new HttpError(404, 'Not found');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'Not found');
    if (project.status !== 'open') throw new HttpError(409, 'This project is closed');
    if (project.ownerId === principal.userId) throw new HttpError(403, 'You cannot pledge to your own project');

    const donor = await ensureUser(principal.userId, principal.identityProvider, principal.userDetails);
    const owner = await getUser(project.ownerId);
    if (!owner?.atlasEmail) throw new HttpError(409, 'The project owner has not provided a RIPE NCC Access email yet');

    const body = await readJson(req);
    const method = oneOf(body, 'method', ['api', 'manual'] as const, true)!;
    const amount = int(body, 'amount', { min: 1, max: MAX_CREDITS, required: true })!;
    const message = str(body, 'message', { max: 500 }) ?? '';

    // Projects accept credits beyond their goal, up to OVERFUND_MULTIPLIER times the request.
    // Pending pledges reserve capacity, so the check uses live totals rather than the cached row.
    const livePledges = await listPledges(id);
    const live = totals(livePledges);
    if (!acceptsMorePledges(project.creditsRequested, live.confirmed)) {
      throw new HttpError(409, `This project has reached its ceiling of ${OVERFUND_MULTIPLIER}× its request and is not accepting more credits`);
    }
    const cap = capacity(project.creditsRequested, live.confirmed, live.pending);
    if (cap === 0) throw new HttpError(409, 'Other donors have reserved the remaining capacity. Try again later.');

    // One live pledge per donor per project. Without this, a single account could reserve a
    // project repeatedly, and could re-read the owner's contact address at will.
    if (activePledgesBy(livePledges, donor.id).length > 0) {
      throw new HttpError(409, 'You already have a pledge in progress on this project. Complete or cancel it first.');
    }

    // No single pledge may reserve the whole ceiling, which would lock every other donor out.
    const perPledge = maxSinglePledge(project.creditsRequested, live.confirmed, live.pending);
    if (amount > perPledge) {
      throw new HttpError(400, `The largest pledge this project accepts right now is ${perPledge.toLocaleString('en-US')} credits`);
    }

    const ts = now();
    const pledge: Pledge = {
      id: newId(),
      projectId: id,
      donorId: donor.id,
      donorName: donor.displayName || donor.handle,
      amount,
      method,
      status: 'pledged',
      transactionUrl: '',
      transactionId: '',
      transferredAt: '',
      transferUncertain: false,
      // An API transfer is in flight from the moment the row exists until the attempt resolves.
      inFlight: method === 'api',
      inFlightSince: '',
      message,
      createdAt: ts,
      updatedAt: ts,
    };

    // Take the donor's single live-pledge slot before anything happens. Reading the pledge list
    // and then writing cannot enforce one live pledge per donor: a request that reads before a
    // rival writes sees nothing to conflict with, and both proceed. Creating one Table Storage row
    // is atomic, so exactly one concurrent request can hold the slot and the rest stop here,
    // before a transfer is sent and before the owner's address is disclosed.
    // Validate the key first. assertKeyFormat throws, and throwing after the slot is taken but
    // before a pledge row exists leaves the slot held for the whole orphan grace, so a donor who
    // simply mistyped their key is locked out of correcting it.
    const apiKey = method === 'api' ? assertKeyFormat(body.apiKey) : '';

    if (!(await acquirePledgeClaim(id, donor.id, pledge.id))) {
      throw new HttpError(409, 'You already have a pledge in progress on this project. Complete or cancel it first.');
    }

    // The row is written before any credits move. Table Storage has no transaction that can span
    // a local write and a call to RIPE, so the order decides which way a failure hurts. An orphan
    // row is a pledge someone cancels; an untracked transfer is credits nobody can account for.
    await createPledge(pledge);

    /**
     * Release the reservation and hand back the error to throw. Callers write
     * `throw await rollback(...)` so that the exit is visible at the call site. Only safe while
     * no credits have moved.
     */
    const rollback = async (err: HttpError): Promise<HttpError> => {
      // Best effort, every step. This runs on the paths where RIPE declined and nothing moved, and
      // the donor's useful answer is that original 4xx: what was wrong and how to fix it. Letting a
      // Table Storage hiccup here replace it with a 500 would hide that, and for an API pledge it
      // would also strand a row the donor is not allowed to cancel. A row or slot left behind is
      // recoverable on its own, through the in-flight window and the reservation expiry; a lost
      // error message is not.
      let withdrawn = false;
      try {
        await savePledge({ ...pledge, status: 'cancelled', inFlight: false });
        withdrawn = true;
      } catch (cleanupErr) {
        console.error('Could not withdraw a pledge after a refused transfer:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      }
      try {
        await recomputeProjectTotals(id);
      } catch {
        // Totals are derived and the next write recomputes them.
      }
      // The slot goes back only if the row was actually withdrawn. Releasing it after a failed
      // cancel would leave a live pledge still reserving capacity with no slot behind it, and the
      // same donor could then open a second live pledge on the project, which is precisely what
      // the slot exists to prevent. A slot left held is the safe direction: it frees itself once
      // the pledge settles, and after the reservation window regardless.
      if (withdrawn) {
        try {
          await releasePledgeClaim(id, donor.id, pledge.id);
        } catch (cleanupErr) {
          console.error('Could not release a pledge slot after a refused transfer:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
        }
      }
      return err;
    };

    // Reserved capacity still needs a post-write settlement, because it spans different donors and
    // no single row can arbitrate between them. Over-reserving is recoverable in a way a double
    // transfer is not: it only holds pending credits, it is re-checked when a pledge is confirmed,
    // and it expires. Losing here costs nothing, because this runs before the transfer.
    // If the totals cannot be read, this check cannot be made, and it must fail closed: a stale
    // snapshot would let a pledge through on a project already filled, and for a manual pledge
    // that is what discloses the owner's address. Nothing has moved yet, so withdrawing and asking
    // for a retry costs the donor nothing.
    let updatedProject: Project;
    try {
      updatedProject = await recomputeProjectTotals(id);
    } catch (err) {
      console.error('Could not recompute project totals before a transfer:', err instanceof Error ? err.message : err);
      throw await rollback(new HttpError(503, 'We could not check this project\u2019s current total just now, so nothing was sent. Please try again in a moment.'));
    }
    if (updatedProject.creditsConfirmed + updatedProject.creditsPending > maxCredits(project.creditsRequested)) {
      throw await rollback(new HttpError(409, 'Another donor took the remaining capacity a moment ago. Please try a smaller amount.'));
    }

    let balanceWarning: string | undefined;
    let recordWarning: string | undefined;
    if (method === 'api') {
      const key = apiKey;
      // Best-effort balance check. A transfer-only key may lack the read permission; that is fine.
      try {
        const credits = await getCredits(key);
        if (typeof credits.current_balance === 'number' && credits.current_balance < amount) {
          throw new HttpError(400, `Your RIPE Atlas balance is ${credits.current_balance.toLocaleString('en-US')} credits, less than the ${amount.toLocaleString('en-US')} you want to send`);
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400 && /balance is/.test(err.message)) throw await rollback(err);
        // Why the check failed decides what to tell the donor. A 401 or 403 really is the key
        // lacking "Get information about your credits", which is worth naming. Anything else is
        // RIPE being slow, rate-limiting or broken, and blaming the donor's key for that sends
        // them off editing permissions that were never the problem.
        const status = err instanceof AtlasRefused ? err.upstreamStatus : 0;
        balanceWarning = status === 401 || status === 403
          ? 'Your balance was not checked first; the key appears to lack the "Get information about your credits" permission.'
          : 'Your balance could not be checked first because RIPE Atlas did not answer the balance request.';
      }

      const startedAt = Date.now();
      // Start the in-flight window here, not at row creation. Everything above this line, the
      // claim, the write and the balance check, happens first, and anchoring the window to
      // createdAt could let it lapse before the transfer was even issued.
      pledge.inFlightSince = new Date(startedAt).toISOString();
      await savePledge(pledge).catch(() => undefined);
      try {
        await transferCredits(key, owner.atlasEmail, amount);
      } catch (err) {
        // Only a refusal frees the slot. AtlasRefused means RIPE read the request and declined,
        // so nothing moved and the donor should be free to correct it and retry at once.
        // Everything else, a timeout, a dropped connection, a 5xx, or anything unexpected escaping
        // from below, says nothing about whether the credits moved. The default has to be "we do
        // not know": treating an unrecognised error as a refusal would free the slot and invite a
        // retry that sends the credits twice.
        if (err instanceof AtlasRefused) {
          throw await rollback(err);
        }
        // Park the pledge exactly where a manual one waits after the donor says they have sent it:
        // the owner confirms it if the credits arrive, the donor cancels it if they never do. It
        // keeps the slot and stays on both dashboards until somebody settles it.
        pledge.status = 'sent';
        pledge.inFlight = false;
        pledge.transferUncertain = true;
        // transferredAt records the moment our server watched RIPE accept the transfer, and here
        // nothing was watched. Leaving it empty keeps that field honest; the status and the
        // uncertain flag are what describe this pledge.
        let recorded = false;
        try {
          await savePledge(pledge);
          recorded = true;
          await recomputeProjectTotals(id);
        } catch (saveErr) {
          console.error('Could not park an uncertain transfer:', saveErr instanceof Error ? saveErr.message : saveErr);
        }
        // Say which of the two situations this is. Claiming a pledge is recorded when the write
        // failed sends the donor looking for something that is not there, and leaves them with no
        // idea that nobody else knows about the transfer either.
        throw new HttpError(
          502,
          `${err instanceof Error ? err.message : 'RIPE Atlas did not answer'}. The credits may still have moved, so check your transaction log at https://atlas.ripe.net/credits/transactions/ before sending again. ${
            recorded
              ? 'The pledge is recorded and waiting for the project owner to confirm it.'
              : 'We could not record the pledge either, so nothing here knows about it: if the credits did move, tell the project owner with your RIPE transaction.'
          }`,
        )
      }

      // Past this point the credits have moved. Nothing below may throw, because there is no
      // longer any failure the donor could usefully act on by retrying.
      pledge.status = 'confirmed';
      pledge.inFlight = false;
      // The moment RIPE accepted, not the moment we asked. startedAt is kept for matching the
      // transaction, where an earlier bound is what we want, but recording it here would date the
      // acceptance up to the full twenty-second timeout early.
      pledge.transferredAt = new Date().toISOString();
      // Persist the confirmation first, before the reference lookup. The lookup is another network
      // call, and leaving the only durable record of a completed transfer behind it meant a crash
      // or a timeout in between left the pledge looking like an untouched reservation. The
      // reference is decoration; the status is the record.
      try {
        await savePledge(pledge);
      } catch (confirmErr) {
        console.error('Transfer completed but the confirmation could not be written yet:', confirmErr instanceof Error ? confirmErr.message : confirmErr);
      }

      try {
        // The transfer endpoint returns a generic list URL, not a per-transfer reference, so look
        // the transaction up to record a real id. A key without the credits-read permission still
        // completes the transfer, it just carries no id.
        const txn = await findTransferTransaction(key, amount, startedAt);
        if (txn) {
          pledge.transactionId = String(txn.id);
          pledge.transactionUrl = `https://atlas.ripe.net/api/v2/credits/transactions/?id=${txn.id}`;
        }
      } catch (lookupErr) {
        // No reference beats failing a transfer that already happened, but it is worth a line in
        // the log: a lookup that keeps failing is a real problem even though it is never fatal.
        console.error('Transaction lookup failed after a completed transfer:', lookupErr instanceof Error ? lookupErr.message : lookupErr);
      }

      // These two are reported separately because they fail differently. If the row never reaches
      // 'confirmed' the owner still has to confirm it by hand; if only the cached totals are stale
      // the pledge is already confirmed and telling the owner to confirm it would be wrong, since
      // there is no transition left for them to make.
      let saved = false;
      try {
        await savePledge(pledge);
        saved = true;
      } catch (err) {
        console.error('Transfer completed but the pledge could not be updated:', err instanceof Error ? err.message : err);
        recordWarning = 'Your transfer completed, but recording it here did not. Do not send it again. The project owner can confirm the pledge once the credits arrive.';
      }
      try {
        updatedProject = await recomputeProjectTotals(id);
      } catch (err) {
        console.error('Transfer completed but project totals could not be recomputed:', err instanceof Error ? err.message : err);
        if (saved) recordWarning = 'Your transfer completed and is recorded. The project totals shown here may lag for a moment.';
      }
      if (saved) {
        // The last unguarded await after the credits moved, and the most dangerous one. Letting a
        // Table Storage blip here escape turns a completed transfer into a 500, and the dialog
        // then re-arms with the key still loaded while the settled pledge has already made the
        // slot reclaimable, so one more click sends the credits again. A stranded slot heals
        // itself once its pledge is settled; a 500 after an irreversible transfer does not.
        try {
          await releasePledgeClaim(id, donor.id, pledge.id);
        } catch (releaseErr) {
          console.error('Could not release a pledge slot after a completed transfer:', releaseErr instanceof Error ? releaseErr.message : releaseErr);
        }
      }
    }

    return json(
      {
        pledge: privatePledge(pledge),
        project: publicProject(updatedProject),
        // Only a donor with a live manual pledge sees where to send credits. The owner can see
        // exactly who that is on their dashboard, because the pledge carries the donor's name.
        recipientEmail: method === 'manual' ? owner.atlasEmail : undefined,
        transferUrl: 'https://atlas.ripe.net/credits/transfer/',
        warning: [balanceWarning, recordWarning].filter(Boolean).join(' ') || undefined,
      },
      201,
    );
  }),
});

app.http('pledges-update', {
  route: 'pledges/{projectId}/{id}',
  methods: ['PATCH'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const principal = requirePrincipal(req);
    const { projectId, id } = req.params;
    if (!isId(projectId) || !isId(id)) throw new HttpError(404, 'Not found');
    const [project, pledge] = await Promise.all([getProject(projectId), getPledge(projectId, id)]);
    if (!project || !pledge) throw new HttpError(404, 'Not found');
    const isOwner = project.ownerId === principal.userId;
    const isDonor = pledge.donorId === principal.userId;
    if (!isOwner && !isDonor) throw new HttpError(403, 'Not allowed');

    const body = await readJson(req);
    const status = oneOf(body, 'status', ['sent', 'confirmed', 'cancelled'] as const, true)!;

    const allowed: Record<string, Array<[from: string, to: string]>> = {
      donor: [
        ['pledged', 'sent'],
        ['pledged', 'cancelled'],
        ['sent', 'cancelled'],
      ],
      owner: [
        ['pledged', 'confirmed'],
        ['sent', 'confirmed'],
        ['pledged', 'cancelled'],
        ['sent', 'cancelled'],
      ],
    };
    const role = isOwner ? 'owner' : 'donor';
    const ok = allowed[role].some(([from, to]) => from === pledge.status && to === status);
    if (!ok) throw new HttpError(409, `Cannot move a ${pledge.status} pledge to ${status} as ${role}`);

    // The row exists before the credits move, so for a moment it is visible while its transfer is
    // still being attempted. Nobody may act on it in that window: confirming or cancelling frees
    // the donor's slot, and a second pledge could then start while the first transfer is still in
    // flight and send the credits again. The window is bounded, so a request that died mid-transfer
    // cannot freeze the row for good.
    if (pledgeInFlight(pledge)) {
      throw new HttpError(409, 'This pledge is still being sent to RIPE Atlas. Give it a moment and reload.');
    }

    // A donor cannot cancel away an API transfer that our server sent. If the row is still
    // 'pledged' on an api pledge, the most likely reason is that the transfer completed and only
    // the follow-up write failed, so cancelling would discard credits that really moved and leave
    // the owner unable to record them. The exception is a transfer we already know is uncertain:
    // there the donor is the one who can read their own transaction log, so they are exactly the
    // right person to settle it. Everything else goes to the owner, who can see what arrived.
    if (role === 'donor' && status === 'cancelled' && pledge.method === 'api' && !pledge.transferUncertain) {
      throw new HttpError(409, 'This transfer was sent through the API, so only the project owner can close it. If the credits never arrived, ask them to cancel it.');
    }

    // An expired reservation no longer holds capacity, and that capacity may already have gone to
    // someone else. What that should prevent is a donor SENDING credits against a reservation
    // that is gone, which is the 'sent' transition. It must not prevent an owner RECORDING credits
    // that already arrived: 'sent' means the donor says the money has moved, so refusing to
    // confirm would strand real credits unrecorded and push people toward transferring again.
    // Confirming is still bounded by the ceiling check below, and cancelling is always available.
    if (status === 'sent' && pledgeExpired(pledge)) {
      throw new HttpError(409, `This pledge has been pending for more than ${PENDING_RESERVATION_DAYS} days and no longer holds its reservation. Cancel it and start a new one before sending anything.`);
    }

    // Confirming must never push confirmed credits past the ceiling, whatever was reserved.
    if (status === 'confirmed') {
      const liveTotals = totals(await listPledges(projectId));
      if (liveTotals.confirmed + pledge.amount > maxCredits(project.creditsRequested)) {
        throw new HttpError(409, `Confirming this pledge would exceed the project's ceiling of ${OVERFUND_MULTIPLIER}× its request; cancel it instead`);
      }
    }
    // This check reads before it writes, so two confirmations racing each other can both pass it.
    // Settling that would need an ETag-guarded aggregate, and it is deliberately not built: only
    // the project's owner can confirm, so the race needs one person double-clicking rather than an
    // adversary, and the outcome is a project recorded slightly above its own ceiling. No credits
    // move here; confirming only records a transfer that already happened, and refusing to record
    // one would be the worse failure. The overshoot is visible on the project and the owner can
    // cancel a pledge back out of it.

    // Conditional on the row not having changed since it was read at the top of this handler. The
    // owner and the donor can both be looking at the same `pledged` pledge; without this, each
    // authorises against that snapshot and whichever writes last wins, so a donor's "sent" landing
    // after an owner's "confirmed" would make a settled pledge live again, after its slot had
    // already been released and its credits counted as confirmed.
    let updated: Pledge;
    try {
      updated = await savePledge({ ...pledge, status }, pledge.etag);
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 412) {
        throw new HttpError(409, 'This pledge changed while you were looking at it. Reload and try again.');
      }
      throw err;
    }
    const updatedProject = await recomputeProjectTotals(projectId);
    // Confirmed and cancelled are both terminal, so the donor's slot on this project is free again.
    if (status === 'confirmed' || status === 'cancelled') {
      await releasePledgeClaim(projectId, pledge.donorId, pledge.id);
    }
    return json({ pledge: privatePledge(updated), project: publicProject(updatedProject) });
  }),
});
