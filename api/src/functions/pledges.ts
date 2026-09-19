import { app, HttpRequest } from '@azure/functions';
import { RestError } from '@azure/data-tables';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, AtlasRefused, AtlasUnreachable, getCredits, transferCredits } from '../lib/atlas';
import { describeErrorForLog, handle, HttpError, json, markNotSent, NOT_SENT, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Pledge, Project, acquirePledgeClaim, activePledgesBy, createPledge, donorMayCancelApiPledge, ensureUser, getPledge, getProject, getUser, listPledges, now, patchProject, pledgeExpired, pledgeInFlight, recomputeProjectTotals, releasePledgeClaim, savePledge, totals } from '../lib/store';
import { bool, int, MAX_CREDITS, oneOf, str } from '../lib/validate';
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
    // Everything raised from here down to the transfer POST is, by construction, a request in
    // which no credits moved: that POST is the only thing in this handler that can move any.
    // Saying so lets the browser keep the form live so the donor can fix the problem and send
    // again, rather than sending them to the check-your-RIPE-account-before-you-send-again screen
    // over a mistyped key. It is done once here rather than at each throw because most of these
    // errors are raised by shared helpers - the principal check, the JSON reader, the field
    // validators, the key format check - which have no idea they are running inside a transfer,
    // and because a throw added here later would otherwise silently inherit the wrong answer.
    // From the POST onwards nothing is added: those paths already say what they know, and an edge
    // or connection failure there is genuinely unknown.
    let transferIssued = false;
    try {
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
      const anonymous = bool(body, 'anonymous');

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
        anonymous,
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
      /**
       * Release the reservation and hand back the error to throw. Callers write
       * `throw await rollback(...)` so that the exit is visible at the call site. Only safe while
       * no credits have moved.
       */
      // Set by rollback when it could not withdraw the row because somebody else had already acted
      // on it. Reachable from every path that rolls back, not only the manual one: until
      // inFlightSince is stored, pledgeInFlight measures from createdAt, so a setup slow enough to
      // outlast that window leaves an API row actionable while the capacity settlement, the balance
      // check and the owner re-read are still running.
      let rollbackFoundConflict = false;
      const rollback = async (err: HttpError): Promise<HttpError> => {
        // Establish a version first when there is none. Only createPledge can leave us here: every other
        // caller holds a version from a write that returned, and overwriting theirs would break the
        // conditional writes downstream that depend on it.
        //
        // This is not a formality. savePledge's ifMatch is optional and pledge.etag is optional, so a
        // withdrawal called with no version type-checks and silently degrades to an unconditional upsert --
        // which would either overwrite a settlement or, worse, CREATE a cancelled row for a pledge that was
        // never written. A guard that reads as present and does nothing is the exact failure this file has
        // been bitten by before.
        if (!pledge.etag) {
          let stored: Pledge | null = null;
          let readFailed = false;
          try {
            stored = await getPledge(id, pledge.id);
          } catch (readErr) {
            readFailed = true;
            console.error('Could not read back a pledge whose creation was ambiguous:', describeErrorForLog(readErr));
          }
          // Ambiguous on top of ambiguous. Hold the slot: the invariant worth keeping is that a live row
          // always has a slot behind it, and releasing buys the donor nothing here anyway, because the
          // one-live-pledge check refuses their retry on the row itself regardless of the slot.
          if (readFailed) return err;
          if (!stored) {
            // The write did not land, so only the slot is held. releasePledgeClaim refuses unless the slot
            // still names this pledge, so it cannot take one somebody else has since reclaimed.
            await releasePledgeClaim(id, donor.id, pledge.id).catch(() => undefined);
            return err;
          }
          // It landed. But a stored row is not necessarily the row we wrote: between the create and this
          // read, a manual pledge is actionable, so the donor or the owner may already have moved it on.
          // Adopting its version and then saving our in-memory copy as cancelled would make the conditional
          // write succeed and overwrite their settlement -- the guard passing precisely because we had just
          // handed it the version it was meant to detect. Anything other than the row as created is somebody
          // else's action, and this request has sent nothing, so leave it alone and say so.
          if (stored.status !== 'pledged' || stored.transferUncertain || stored.transferredAt) {
            return new HttpError(
              409,
              'Somebody acted on this pledge while it was being created, and it may already record a transfer. Open it on your dashboard before sending anything.',
              { transfer: 'unknown' },
            );
          }
          // The row as we wrote it, so only the answer was lost. Withdraw it properly.
          pledge.etag = stored.etag;
        }
        // Best effort, every step. Every path that reaches here is one where nothing moved: RIPE
        // declined, or the request gave up before sending. The donor's useful answer is that original
        // error, what was wrong and how to fix it. Letting a Table Storage hiccup here replace it with
        // a 500 would hide that, and for an API pledge it would also strand a row the donor is not
        // allowed to cancel. A row or slot left behind is recoverable on its own, through the
        // in-flight window and the reservation expiry; a lost error message is not.
        let withdrawn = false;
        try {
          // Conditional on the row still being the one we created. A manual pledge is actionable the
          // instant it is written, so the owner or the donor may have moved it to sent or confirmed
          // while the capacity check above was running, and an unconditional replace would overwrite
          // that with cancelled and then release its slot, losing a transfer somebody had already
          // made. A 412 means exactly that happened, and the right answer is to leave their row be.
          await savePledge({ ...pledge, status: 'cancelled', inFlight: false }, pledge.etag);
          withdrawn = true;
        } catch (cleanupErr) {
          const changed = cleanupErr instanceof RestError && cleanupErr.statusCode === 412;
          if (changed) rollbackFoundConflict = true;
          console.error(
            changed
              ? 'Did not withdraw a pledge: somebody had already acted on it'
              : 'Could not withdraw a pledge:',
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
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
            console.error('Could not release a pledge slot:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
          }
        }
        // Whoever else acted decides what this request may offer, so answer it here rather than at
        // each call site: every caller wants the same thing, and the one that had this inline was
        // the only one of five that did. A cancellation is unambiguous -- nothing was sent, the
        // claim went back with it, and the donor should be free to try again, which is what the
        // original error already tells them. A row now marked sent or confirmed means somebody
        // believes credits have moved, and handing back a retryable refusal there is how the same
        // credits get sent twice. A read that fails keeps the stricter answer.
        if (rollbackFoundConflict) {
          const settled = await getPledge(id, pledge.id).catch(() => null);
          if (!settled || settled.status === 'sent' || settled.status === 'confirmed') {
            return new HttpError(
              409,
              'Somebody acted on this pledge while this request was running, and it may already record a transfer. Open it on your dashboard before sending anything.',
              { transfer: 'unknown' },
            );
          }
        }
        return err;
      };


      // The row is written before any credits move. Table Storage has no transaction that can span
      // a local write and a call to RIPE, so the order decides which way a failure hurts. An orphan
      // row is a pledge someone cancels; an untracked transfer is credits nobody can account for.
      //
      // This is the one write on the path where no prior version exists, which is why it was the one the
      // reconcilers downstream could not cover: each of those re-reads a row it already wrote. A create
      // that commits and loses its answer left the row and the slot behind while the response told the
      // donor to try again, and their retry was then refused by a pledge only the owner could clear.
      try {
        pledge.etag = (await createPledge(pledge)).etag;
      } catch (createErr) {
        console.error('Could not create a pledge row:', describeErrorForLog(createErr));
        throw await rollback(new HttpError(503, 'We could not record your pledge just now, so nothing was sent. Please try again in a moment.', NOT_SENT));
      }

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
        throw await rollback(new HttpError(503, 'We could not check this project’s current total just now, so nothing was sent. Please try again in a moment.', NOT_SENT));
      }
      if (updatedProject.creditsConfirmed + updatedProject.creditsPending > maxCredits(project.creditsRequested)) {
        throw await rollback(new HttpError(409, 'Another donor took the remaining capacity a moment ago. Please try a smaller amount.'));
      }

      let balanceWarning: string | undefined;
      let recordWarning: string | undefined;
      // Set when the post-transfer write did not commit, so the response can describe the row that
      // actually exists rather than the one we intended to write.
      let apiSaveFailed = false;
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
        // Re-read the owner immediately before sending. The snapshot at the top of this handler is
        // minutes old by now, and a concurrent DELETE /api/me can have completed in between and been
        // told the address was removed. Transferring to a cached address after that would move
        // credits to an account the person has asked us to forget.
        let ownerNow: Awaited<ReturnType<typeof getUser>>;
        try {
          ownerNow = await getUser(project.ownerId);
        } catch (ownerErr) {
          // A storage failure here is not the owner being gone, but either way no transfer has been
          // made, so the row and the slot must not be left behind holding the donor out.
          console.error('Could not re-read the project owner before transferring:', ownerErr instanceof Error ? ownerErr.message : ownerErr);
          throw await rollback(new HttpError(503, 'We could not confirm where to send the credits just now, so nothing was sent. Please try again in a moment.', NOT_SENT));
        }
        if (!ownerNow?.atlasEmail) {
          throw await rollback(new HttpError(409, 'The project owner is no longer available, so nothing was sent.', NOT_SENT));
        }

        const startedAt = Date.now();
        // Start the in-flight window here, not at row creation. Everything above this line, the
        // claim, the write and the balance check, happens first, and anchoring the window to
        // createdAt could let it lapse before the transfer was even issued.
        pledge.inFlightSince = new Date(startedAt).toISOString();
        // Not best-effort. This marker is what keeps the in-flight window anchored to the transfer
        // rather than to row creation, and without it the stored row falls back to createdAt, which
        // the claim, the write and the balance check above may already have used up. The owner could
        // then settle the row while the transfer is still running and free the slot. Nothing has been
        // sent yet, so the safe answer is to give up and let the donor try again.
        try {
          // Conditional on the row still being the one this request created. Until inFlightSince is
          // stored, pledgeInFlight measures the window from createdAt, so a setup slow enough to
          // outlast it makes this row actionable: the owner or the donor can settle it while the
          // balance check and the owner re-read above are still running. An unconditional replace
          // would put their settlement back to in-flight and then transfer against it.
          //
          // It also keeps the version current, which the rollback below depends on. Holding the
          // create-time version past this write is what made that rollback fail 412 on every
          // ordinary refusal.
          pledge.etag = (await savePledge(pledge, pledge.etag)).etag;
        } catch (markErr) {
          // A 412 is not a failure to write, it is somebody else having acted. Their settlement is
          // the state that should survive, and it released the claim on its way, so there is
          // nothing here to roll back and nothing to send. Rolling back would overwrite the thing
          // the guard just protected.
          if (markErr instanceof RestError && markErr.statusCode === 412) {
            // Somebody else acted on the row. Which of the two things they did decides what to
            // offer, exactly as on the manual branch below. A cancellation is unambiguous: nothing
            // was sent, the claim went back with it, and the donor should be free to try again. A
            // row now marked sent or confirmed means somebody believes credits have moved, and
            // saying not-sent there would let the donor start a second transfer against it.
            const settled = await getPledge(id, pledge.id).catch(() => null);
            if (settled && settled.status === 'cancelled') {
              throw new HttpError(409, 'This pledge was cancelled while the transfer was being set up, so nothing was sent. You can start a new one.', NOT_SENT);
            }
            throw new HttpError(409, 'This request sent nothing, but somebody else acted on this pledge while it was being set up, so it may already record a transfer. Open it on your dashboard before sending anything.', { transfer: 'unknown' });
          }
          console.error('Could not record the transfer start marker:', describeErrorForLog(markErr));
          // Any other failure is ambiguous: the write may have been applied and only its answer
          // lost, leaving the row a version ahead of the one held here, so the conditional
          // withdrawal below would fail 412 and strand the row in flight holding the donor's slot.
          // Re-reading gives the current version -- but the row may equally have moved because
          // somebody settled it, and adopting their version to force a withdrawal through would
          // overwrite the settlement this handler is elsewhere careful to protect. So read the
          // status, not just the version.
          const fresh = await getPledge(id, pledge.id).catch(() => null);
          if (fresh && (fresh.status === 'sent' || fresh.status === 'confirmed')) {
            throw new HttpError(409, 'This request sent nothing, but somebody else acted on this pledge while it was being set up, so it may already record a transfer. Open it on your dashboard before sending anything.', { transfer: 'unknown' });
          }
          if (fresh && fresh.status === 'cancelled') {
            // Already withdrawn, and the claim went with it. Nothing to roll back.
            throw new HttpError(409, 'This pledge was cancelled while the transfer was being set up, so nothing was sent. You can start a new one.', NOT_SENT);
          }
          if (fresh?.etag) pledge.etag = fresh.etag;
          throw await rollback(new HttpError(503, 'We could not start the transfer safely just now, so nothing was sent. Please try again in a moment.', NOT_SENT));
        }
        // Set before the call, not after. The moment the POST is issued the outcome stops
        // being ours to assert, so every error from here on is left to say what it actually
        // knows instead of inheriting a blanket "nothing was sent".
        transferIssued = true;
        try {
          await transferCredits(key, ownerNow.atlasEmail, amount);
        } catch (err) {
          // Only a refusal frees the slot. AtlasRefused means RIPE read the request and declined,
          // so nothing moved and the donor should be free to correct it and retry at once.
          // Everything else, a timeout, a dropped connection, a 5xx, or anything unexpected escaping
          // from below, says nothing about whether the credits moved. The default has to be "we do
          // not know": treating an unrecognised error as a refusal would free the slot and invite a
          // retry that sends the credits twice.
          if (err instanceof AtlasRefused) {
            // RIPE read the request and declined, so this is a definite no-send.
            throw await rollback(new HttpError(err.status, err.message, NOT_SENT));
          }
          // Park the pledge at `sent`, where a manual one waits after the donor says they have sent
          // it. It keeps the slot and stays on both dashboards until the owner settles it: they
          // confirm if the credits arrived and cancel if they never did. Only they, for an API
          // pledge -- cancelling frees the donor's slot, and if the transfer did go through the
          // donor's next pledge would send the same credits again.
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
            console.error('Could not park an uncertain transfer:', describeErrorForLog(saveErr));
            // A failed write does not prove nothing was written: Table Storage can apply an update
            // and lose the response, exactly as the confirmation path above allows for. What the
            // donor is told next turns on this -- with a row, the researcher settles it; without
            // one, there is nothing to settle and they have to be told out of band. So ask the row
            // rather than the exception. A read that fails too leaves recorded false, which is the
            // safe direction: it sends the donor to tell the researcher, which is harmless if a row
            // did exist and necessary if it did not.
            if (!recorded) {
              // What this decides is whether the donor is told a pledge is waiting for the owner
              // to settle it. A row still open counts, whether the failed transition left it at
              // `pledged` or landed it at `sent`: createPledge succeeded long before this, so the
              // earlier row survives either way and the owner can see it. A row already settled
              // does not: telling somebody their cancelled pledge is waiting for confirmation hides
              // that its claim went back and that nothing is tracking the transfer any more.
              const stored = await getPledge(id, pledge.id).catch(() => null);
              if (stored && (stored.status === 'sent' || stored.status === 'pledged')) recorded = true;
            }
            // If the row was updated but the totals were not, nothing revisits a project whose
            // cached pending is zero, so mark it for the refreshers to pick up.
            if (recorded) await patchProject(id, { totalsDirty: true }).catch(() => undefined);
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
            // In the message for a person, and here for the screen that follows it. Whether a row
            // exists changes what the donor should do: a recorded pledge is one the owner settles,
            // and an unrecorded one is not there to be settled, so telling them to hand it over
            // would send them to somebody with nothing to act on.
            { transferRecorded: recorded },
          )
        }

        // Past this point the credits have moved. Nothing below may throw, because there is no
        // longer any failure the donor could usefully act on by retrying.
        pledge.status = 'confirmed';
        pledge.inFlight = false;
        // The moment RIPE accepted, not the moment we asked. startedAt anchors the in-flight
        // window, which wants the earlier bound; recording it here would date the acceptance up to
        // the full twenty-second timeout early.
        pledge.transferredAt = new Date().toISOString();
        // The one write that matters: it is what makes `confirmed` durable.
        //
        // No transaction lookup precedes it and none follows. RIPE does not index the transaction
        // until well after it accepts the transfer (measured live: absent immediately, present 40
        // to 70 seconds later), so a call here could only ever come back empty. The 201 is what
        // records that the credits moved and transferredAt is when we saw it. Dropping the call
        // also takes a RIPE round trip off the request, which is what keeps the worst case inside
        // the platform's own timeout.
        let saved = false;
        try {
          await savePledge(pledge);
          saved = true;
        } catch (confirmErr) {
          console.error('Transfer completed but the confirmation could not be written:', describeErrorForLog(confirmErr));
          // One more attempt at the same confirmed row, not a reduced one.
          //
          // This used to write back `pledged` with the transfer fields cleared, to get the in-flight
          // marker off the row so the owner could act on it. That produced the worst state on this
          // path: an ordinary-looking pending pledge for a transfer RIPE had already accepted. The
          // owner could cancel it from the project page, which drops the received credits from the
          // totals and releases the donor's slot, and the donor's next pledge would then send the
          // same credits a second time -- the exact failure everything else here exists to prevent.
          //
          // Retrying the confirmation has none of that. It is the same size of write, since
          // savePledge replaces the whole row either way, so it is no less likely to land; if it
          // does, the row says what actually happened and the marker is cleared as a side effect.
          // If it does not, the stored row stays the pre-transfer marker, which carries no transfer
          // fields and no false confirmation, and the in-flight window releases it on its own.
          //
          // Conditional on the marker version. If the write above was in fact applied and only its
          // response was lost, the row has already moved past that version, and the 412 below is
          // how we find out.
          try {
            await savePledge(pledge, pledge.etag);
            saved = true;
          } catch (clearErr) {
            if (!(clearErr instanceof RestError && clearErr.statusCode === 412)) {
              console.error('Could not record a completed transfer on retry either:', describeErrorForLog(clearErr));
            }
            // Ask the row, whatever the exception was, because neither answer settles it alone. A
            // 412 says the version moved, not who moved it: the first write may have landed with
            // its response lost, or the in-flight grace may have expired and let the owner settle
            // the pledge themselves. A non-412 is ambiguous for the same reason the first write
            // was -- Table Storage can apply a replacement and lose the answer. Only a row that
            // actually reads `confirmed` means this transfer is recorded; anything else leaves the
            // warning standing, which is the honest answer.
            const stored = await getPledge(id, pledge.id).catch(() => null);
            if (stored?.status === 'confirmed') saved = true;
          }
        }
        if (!saved) {
          apiSaveFailed = true;
          recordWarning = 'Your transfer completed, but recording it here did not. Do not send it again. The project owner can confirm the pledge once the credits arrive. If their dashboard refuses at first, it will accept a minute or two later.';
        }
        try {
          updatedProject = await recomputeProjectTotals(id);
        } catch (err) {
          console.error('Transfer completed but project totals could not be recomputed:', err instanceof Error ? err.message : err);
          // Nothing else will repair this on its own. A confirmed pledge leaves pending at zero, and
          // both maintenance refreshers only look at projects showing a reservation, so this row
          // would sit wrong indefinitely. Mark it so they pick it up.
          await patchProject(id, { totalsDirty: true }).catch(() => undefined);
          if (saved) recordWarning = 'Your transfer completed and is recorded. The project totals shown here are queued to be recalculated.';
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

      // A manual pledge is only useful if it can name a recipient, so resolve that before answering.
      // The owner's profile can be deleted while this request is running, and returning a 201 with
      // no address would leave the donor holding a slot, a pledge they cannot act on, and
      // instructions with a blank in them. Withdraw instead and say so.
      let recipientEmail: string | undefined;
      if (method === 'manual') {
        // A storage failure reading the owner is not the owner being gone, but either way this
        // request is not going to disclose an address, and leaving the row and the slot behind would
        // hold the donor out of a project they never managed to pledge to. The API path rolls the
        // same failure back; this one used to let it escape to the outer catch untouched.
        let ownerRow: Awaited<ReturnType<typeof getUser>>;
        try {
          ownerRow = await getUser(project.ownerId);
        } catch (ownerErr) {
          console.error('Could not read the project owner for a manual pledge:', ownerErr instanceof Error ? ownerErr.message : ownerErr);
          throw await rollback(new HttpError(503, 'We could not look up where to send the credits just now, so the pledge was not created. Please try again in a moment.'));
        }
        recipientEmail = ownerRow?.atlasEmail || undefined;
        if (!recipientEmail) {
          // Exactly the API path's rollback, for exactly its reasons. A manual pledge is actionable
          // the moment its row exists, so between that write and this read the donor may have marked
          // it sent or the owner confirmed it. An unconditional replace would overwrite either with
          // cancelled and then hand back the slot, losing the record of a transfer somebody had
          // already made. Conditional on the version we created, a 412 says precisely that happened
          // and the right answer is to leave their row alone. The slot goes back only if the
          // withdrawal actually landed: releasing it after a failed cancel leaves a live pledge
          // reserving capacity with no slot behind it, and the same donor could then open a second.
          // rollback answers the concurrent-change case itself, for every path that uses it.
          throw await rollback(new HttpError(409, 'The project owner is no longer available, so the pledge was not created and nothing was sent.'));
        }
      }

      // Only when the confirmation is known not to have persisted -- apiSaveFailed is set after
      // both attempts have failed and a re-read has not found a confirmed row, so a write whose
      // response was merely lost has already been reconciled above and does not reach here. In that
      // case the stored row is the pre-transfer one and the response must not claim otherwise. The
      // credits did move, which the warning says, but reporting `confirmed` would have the dialog
      // and the dashboard disagree about the same pledge and tell the donor a record exists that
      // nobody can find. Report the row that exists rather than a mix of the two: status, the
      // transfer timestamp and any reference all have to describe the same thing, or the success
      // screen contradicts both storage and its own warning.
      const reported = apiSaveFailed
        ? { ...pledge, status: 'pledged' as const, inFlight: false, transferredAt: '', transactionId: '', transactionUrl: '' }
        : pledge;

      return json(
        {
          pledge: privatePledge(reported),
          project: publicProject(updatedProject),
          // Only a donor with a live manual pledge sees where to send credits. The owner can see
          // exactly who that is on their dashboard, because the pledge carries the donor's name.
          // Re-read rather than serving the snapshot taken at the top of this handler. A concurrent
          // profile deletion can have completed since, and been told the address was removed; this
          // response is the disclosure, so it has to reflect the state at the moment it is sent.
          recipientEmail,
          transferUrl: 'https://atlas.ripe.net/credits/transfer/',
          warning: [balanceWarning, recordWarning].filter(Boolean).join(' ') || undefined,
        },
        201,
      );
    } catch (err) {
      if (transferIssued) throw err;
      // markNotSent replaces an unexpected failure with a generic 500, so log it here: handle()
      // will not see the original any more. By type only. The comment this replaces said the
      // message must not be published because an unknown error can carry the request body, which
      // on this route holds an API key, and then passed that message straight to console.error.
      if (!(err instanceof HttpError)) {
        console.error('Unexpected failure before a transfer was issued:', describeErrorForLog(err));
      }
      throw markNotSent(err);
    }
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

    // An API pledge only reaches 'sent' by one route: the transfer was issued and RIPE gave no
    // usable answer. It is parked there, holding the donor's slot, precisely so a blind retry
    // cannot happen. Letting the donor cancel it undoes that, because cancelling frees the slot,
    // and if RIPE did complete the transfer the next pledge sends the credits a second time. The
    // donor can read their own transaction log, but acting on it here has a side effect they
    // cannot see. Only the owner settles these: they are the one who can say whether the credits
    // arrived, and either answer they give is safe.
    if (!isOwner && pledge.method === 'api' && pledge.status === 'sent' && status === 'cancelled') {
      throw new HttpError(
        409,
        'This transfer was sent to RIPE Atlas and we never got a usable answer, so only the project owner can close it. Check your transaction log, then tell them what you find.',
      );
    }
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
    // the owner unable to record them.
    //
    // This once carried an exception for a transfer already known to be uncertain, on the reasoning
    // that the donor can read their own transaction log. It never took effect and the reasoning was
    // wrong on both counts. transferUncertain is only ever set together with status 'sent', and the
    // guard above rejects a donor cancelling a sent API pledge before this line is reached, so the
    // exception was dead. It also contradicted that guard in writing, which is the more expensive
    // half: the next person to read this file found two comments stating opposite policies. Reading
    // the log is not the problem; acting on it here frees the slot, and if RIPE did complete the
    // transfer the next pledge sends the credits a second time. The owner settles these.
    //
    // `method === 'api'` alone is too broad a proxy for "a transfer may have been issued". The real
    // distinguisher is inFlightSince, which is written before the POST and not best-effort: the handler
    // gives up if that write fails, so a `pledged` API row without it provably never reached RIPE. Those
    // rows exist because creating the pledge or checking the balance failed, and holding their donor to an
    // owner-only rule stranded them behind a pledge they could not clear and the owner had no reason to
    // look at. Rows that did reach the POST keep the rule.
    if (role === 'donor' && status === 'cancelled' && pledge.method === 'api' && !donorMayCancelApiPledge(pledge)) {
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
