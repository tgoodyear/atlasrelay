import { app, HttpRequest } from '@azure/functions';
import { RestError } from '@azure/data-tables';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, AtlasRefused, findTransferTransaction, getCredits, transferCredits } from '../lib/atlas';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Pledge, Project, acquirePledgeClaim, activePledgesBy, createPledge, ensureUser, getPledge, getProject, getUser, listPledges, now, patchProject, pledgeExpired, recomputeProjectTotals, releasePledgeClaim, savePledge, totals } from '../lib/store';
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

    let balanceWarning: string | undefined;
    if (method === 'api') {
      const key = apiKey;
      // Best-effort balance check. A transfer-only key may lack the read permission; that is fine.
      try {
        const credits = await getCredits(key);
        if (typeof credits.current_balance === 'number' && credits.current_balance < amount) {
          throw new HttpError(400, `Your RIPE Atlas balance is ${credits.current_balance.toLocaleString('en-US')} credits, less than the ${amount.toLocaleString('en-US')} you want to send`);
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400 && /balance is/.test(err.message)) {
          await releasePledgeClaim(id, donor.id, pledge.id);
          throw err;
        }
        // Why the check failed decides what to tell the donor. A 401 or 403 really is the key
        // lacking "Get information about your credits", which is worth naming. Anything else is
        // RIPE being slow, rate-limiting or broken, and blaming the donor's key for that sends
        // them off editing permissions that were never the problem.
        const status = err instanceof AtlasRefused ? err.upstreamStatus : 0;
        balanceWarning = status === 401 || status === 403
          ? 'Your balance was not checked first; the key appears to lack the "Get information about your credits" permission.'
          : 'Your balance could not be checked first because RIPE Atlas did not answer the balance request.';
      }
      // Re-read the owner immediately before sending. The snapshot at the top of this handler is
      // minutes old by now, and a concurrent DELETE /api/me can have completed in between and been
      // told the address was removed. Transferring to a cached address after that would move
      // credits to an account the person has asked us to forget.
      const ownerNow = await getUser(project.ownerId);
      if (!ownerNow?.atlasEmail) {
        // Nothing has been sent, so give the slot back and stop.
        await releasePledgeClaim(id, donor.id, pledge.id).catch(() => undefined);
        throw new HttpError(409, 'The project owner is no longer available, so nothing was sent.');
      }

      const startedAt = Date.now();
      try {
        await transferCredits(key, ownerNow.atlasEmail, amount);
      } catch (err) {
        // Only a refusal frees the slot. AtlasRefused means RIPE read the request and declined, so
        // nothing moved and the donor should be able to correct the problem and try again at once.
        // Anything else is a timeout, a dropped connection or a 5xx, none of which say whether the
        // credits moved. Releasing the slot there would invite a retry that sends them twice, so
        // the pledge is recorded as sent, keeps the slot, and waits for a person to settle it.
        if (err instanceof AtlasRefused) {
          await releasePledgeClaim(id, donor.id, pledge.id);
          throw err;
        }
        pledge.status = 'sent';
        pledge.transferredAt = '';
        let recorded = false;
        try {
          await createPledge(pledge);
          recorded = true;
          await recomputeProjectTotals(id);
        } catch (saveErr) {
          console.error('Could not record a transfer of unknown outcome:', saveErr instanceof Error ? saveErr.message : saveErr);
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
        );
      }
      pledge.status = 'confirmed';
      // The moment RIPE accepted, not the moment we asked. startedAt is kept for matching the
      // transaction, where an earlier bound is what we want, but recording it here would date the
      // acceptance up to the full twenty-second timeout early.
      pledge.transferredAt = new Date().toISOString();
      // The transfer endpoint returns a generic list URL, not a per-transfer reference, so look
      // the transaction up to record a real id. Every failure here is "no reference": the credits
      // have already moved, and letting this throw would skip the pledge write entirely, leaving
      // the claim to expire and a retry free to send them again.
      try {
        const txn = await findTransferTransaction(key, amount, startedAt);
        if (txn) {
          pledge.transactionId = String(txn.id);
          pledge.transactionUrl = `https://atlas.ripe.net/api/v2/credits/transactions/${txn.id}/`;
        }
      } catch (lookupErr) {
        console.error('Transaction lookup failed after a completed transfer:', lookupErr instanceof Error ? lookupErr.message : lookupErr);
      }
    }

    // For an API pledge the credits have already moved by the time we get here, so failing the
    // request would tell the donor to retry a transfer that already happened. The write is
    // attempted, and if it cannot be made the response still succeeds and says so plainly. The
    // next change in this stack writes the row before the transfer instead, which removes this
    // window rather than softening it; this is the best available while it is written afterwards.
    let recordWarning: string | undefined;
    try {
      await createPledge(pledge);
    } catch (err) {
      if (method === 'manual') throw err;
      console.error('Transfer completed but the pledge could not be recorded:', err instanceof Error ? err.message : err);
      recordWarning = 'Your transfer completed, but recording it here did not. Do not send it again. Tell the project owner, with your RIPE transaction, so they can confirm it by hand.';
    }
    // Swallowing a failed recompute and carrying on with the snapshot read at the top of this
    // handler was wrong in a way worth naming: the ceiling check below is computed from these
    // totals, and a stale snapshot makes it fail OPEN. For a manual pledge that check is what
    // stands between a donor and the owner's address, so failing open would disclose it on a
    // project that had already been filled by others.
    let updatedProject: Project | undefined;
    try {
      updatedProject = await recomputeProjectTotals(id);
    } catch (err) {
      console.error('Could not recompute project totals after a pledge:', err instanceof Error ? err.message : err);
    }

    if (!updatedProject) {
      if (method === 'manual') {
        // No credits have moved, so the safe answer is to withdraw and let them try again. Better
        // a retry than an address handed out against totals we could not verify.
        //
        // The slot is released only if the withdrawal actually succeeded. Releasing it after a
        // failed cancel would leave a live pledge still reserving capacity with no slot behind it,
        // which is the one state the slot exists to make impossible: the same donor could then
        // open a second live pledge on the project.
        let withdrawn = false;
        try {
          await savePledge({ ...pledge, status: 'cancelled' });
          withdrawn = true;
        } catch (cancelErr) {
          console.error('Could not withdraw a pledge after an unreadable project total:', cancelErr instanceof Error ? cancelErr.message : cancelErr);
        }
        if (withdrawn) {
          await releasePledgeClaim(id, donor.id, pledge.id).catch(() => undefined);
          throw new HttpError(503, 'We could not check this project\u2019s current total just now, so the pledge was not created. Please try again in a moment.');
        }
        throw new HttpError(503, 'We could not check this project\u2019s current total just now, and could not tidy up the pledge either. It may still be showing as pending; cancel it from your dashboard before trying again.');
      }
      // An API transfer has already happened and cannot be withdrawn, so this one proceeds, but on
      // figures known to be stale. There is no "next pledge" to repair them either: a confirmed
      // pledge leaves pending at zero, and both refreshers only look at projects showing a
      // reservation, so this row would sit wrong indefinitely. Mark it so they pick it up.
      updatedProject = project;
      await patchProject(id, { totalsDirty: true }).catch(() => undefined);
      recordWarning = [recordWarning, 'The project totals shown may be out of date; they are queued to be recalculated.'].filter(Boolean).join(' ');
    }

    // Reserved capacity still needs a post-write settlement, because it spans different donors and
    // no single row can arbitrate between them. Only a manual pledge can be withdrawn.
    let overshootWarning: string | undefined;
    const ceiling = maxCredits(project.creditsRequested);
    const reserved = updatedProject.creditsConfirmed + updatedProject.creditsPending;
    if (reserved > ceiling) {
      if (method === 'manual') {
        await savePledge({ ...pledge, status: 'cancelled' });
        updatedProject = await recomputeProjectTotals(id);
        await releasePledgeClaim(id, donor.id, pledge.id);
        throw new HttpError(409, 'Another donor took the remaining capacity a moment ago. Please try a smaller amount.');
      }
      overshootWarning = `This transfer completed, but concurrent pledges have taken the project ${(reserved - ceiling).toLocaleString('en-US')} credits beyond its ceiling.`;
    }

    return json(
      {
        pledge: privatePledge(pledge),
        project: publicProject(updatedProject),
        // Only a donor with a live manual pledge sees where to send credits. The owner can see
        // exactly who that is on their dashboard, because the pledge carries the donor's name.
        // Re-read rather than serving the snapshot taken at the top of this handler. A concurrent
        // profile deletion can have completed since, and been told the address was removed; this
        // response is the disclosure, so it has to reflect the state at the moment it is sent.
        recipientEmail: method === 'manual' ? (await getUser(project.ownerId))?.atlasEmail || undefined : undefined,
        transferUrl: 'https://atlas.ripe.net/credits/transfer/',
        warning: [balanceWarning, overshootWarning, recordWarning].filter(Boolean).join(' ') || undefined,
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
