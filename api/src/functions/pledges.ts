import { app, HttpRequest } from '@azure/functions';
import { RestError } from '@azure/data-tables';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, AtlasRefused, AtlasUnreachable, getCredits, transferCredits } from '../lib/atlas';
import { handle, HttpError, json, markNotSent, NOT_SENT, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { Pledge, Project, acquirePledgeClaim, activePledgesBy, createPledge, donorMayCancelApiPledge, ensureUser, getPledge, getProject, getUser, listPledges, now, patchProject, pledgeExpired, acquireConfirmLock, ownerReceiptLedger, pledgeInFlight, releaseConfirmLock, recomputeProjectTotals, releasePledgeClaim, releaseReceipt, reserveReceipt, savePledge, totals, type ReceiptLedger } from '../lib/store';
import { checkReceipt, type CheckedConfirmation, type VerificationDetails } from '../lib/receipts';
import { bool, int, MAX_CREDITS, oneOf, str } from '../lib/validate';
import { OVERFUND_MULTIPLIER, PENDING_RESERVATION_DAYS, acceptsMorePledges, capacity, maxCredits, maxSinglePledge } from '../lib/pledging';
import { privatePledge, publicProject } from '../lib/views';
import { logError, logEvent } from '../lib/telemetry';

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
        receivedAmount: 0,
        amountVerified: false,
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
      // outlast that window leaves an API row actionable while the capacity settlement and the
      // balance check are still running.
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
            logError('Could not read back a pledge whose creation was ambiguous', readErr);
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
          // `sent` and transferUncertain no longer imply somebody else acted: this request sets both
          // just before the POST, so a marker write whose answer was lost produces exactly that row.
          // inFlightSince is generated by this request and nothing else, so it is what distinguishes our
          // own write from a stranger's. Reporting "may already record a transfer" for a POST that was
          // never issued is wrong in the expensive direction -- it strands the donor.
          const oursAlready = Boolean(stored.inFlightSince) && stored.inFlightSince === pledge.inFlightSince;
          if (!oursAlready && (stored.status !== 'pledged' || stored.transferUncertain || stored.transferredAt)) {
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
          // transferUncertain is cleared along with the status. The marker is now set before the POST,
          // so a row reaching here after a refusal carries it, and leaving it on a cancelled row would
          // pollute the operator's `transferUncertain eq true` query with rows that are settled.
          await savePledge({ ...pledge, status: 'cancelled', inFlight: false, transferUncertain: false }, pledge.etag);
          withdrawn = true;
        } catch (cleanupErr) {
          const changed = cleanupErr instanceof RestError && cleanupErr.statusCode === 412;
          if (changed) rollbackFoundConflict = true;
          logError(
            changed
              ? 'Did not withdraw a pledge: somebody had already acted on it'
              : 'Could not withdraw a pledge',
            cleanupErr,
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
            logError('Could not release a pledge slot', cleanupErr);
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
        logError('Could not create a pledge row', createErr);
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
        logError('Could not recompute project totals before a transfer', err);
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
        const startedAt = Date.now();
        // Start the in-flight window here, not at row creation. Everything above this line, the
        // claim, the write and the balance check, happens first, and anchoring the window to
        // createdAt could let it lapse before the transfer was even issued.
        pledge.inFlightSince = new Date(startedAt).toISOString();
        // Write the uncertainty ahead of the POST rather than after it.
        //
        // "We do not know whether the credits moved" used to be recorded once RIPE had failed to answer,
        // which means it could only ever exist if this handler survived the very failure it describes. A
        // process that died between the POST and that write left the row saying `pledged`, whose meaning is
        // the opposite: nothing was sent. There was a state for "issued and the answer was written down",
        // and a state for "an attempt is running", and none at all for "issued, no answer ever recorded".
        //
        // Marking it pessimistically here gives that state a home, and every write below narrows it: a 201
        // clears both flags, a refusal cancels the row, and anything else leaves it already saying the right
        // thing. Whatever kills the process from this point on, storage is correct without anyone's help.
        //
        // It buys an invariant worth more than the flag: a stored row at `pledged` with inFlight set now
        // proves the POST was never issued, because the POST is reachable only once this write has returned
        // and nothing else ever writes that combination.
        pledge.status = 'sent';
        pledge.transferUncertain = true;
        // Not best-effort. This marker is what keeps the in-flight window anchored to the transfer
        // rather than to row creation, and without it the stored row falls back to createdAt, which
        // the claim, the write and the balance check above may already have used up. The owner could
        // then settle the row while the transfer is still running and free the slot. Nothing has been
        // sent yet, so the safe answer is to give up and let the donor try again.
        try {
          // Conditional on the row still being the one this request created. Until inFlightSince is
          // stored, pledgeInFlight measures the window from createdAt, so a setup slow enough to
          // outlast it makes this row actionable: the owner or the donor can settle it while the
          // balance check above is still running. An unconditional write
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
          logError('Could not record the transfer start marker', markErr);
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
        // Re-read the owner immediately before sending, and only after the marker above is stored.
        //
        // The snapshot at the top of this handler is seconds old by now, and a concurrent DELETE /api/me
        // can have completed in between and been told the address was removed. Re-reading narrows that
        // window but cannot close it alone: deletion can still land between this read and the POST
        // (#20). The order closes it. This request writes its marker and then reads the owner; deletion
        // removes the owner and then reads the pledges on the owner's projects. Whichever goes second
        // sees the other: either this read finds the owner gone and nothing is sent, or deletion finds
        // this marker and tells the person a transfer was already under way, instead of promising the
        // address is out of use while credits are on their way to it.
        let ownerNow: Awaited<ReturnType<typeof getUser>>;
        try {
          ownerNow = await getUser(project.ownerId);
        } catch (ownerErr) {
          // A storage failure here is not the owner being gone, but either way no transfer has been
          // made, so the row and the slot must not be left behind holding the donor out.
          logError('Could not re-read the project owner before transferring', ownerErr);
          throw await rollback(new HttpError(503, 'We could not confirm where to send the credits just now, so nothing was sent. Please try again in a moment.', NOT_SENT));
        }
        if (!ownerNow?.atlasEmail) {
          throw await rollback(new HttpError(409, 'The project owner is no longer available, so nothing was sent.', NOT_SENT));
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
            logEvent('transfer', { outcome: 'refused', upstreamStatus: err.upstreamStatus, projectId: id, pledgeId: pledge.id });
            throw await rollback(new HttpError(err.status, err.message, NOT_SENT));
          }
          // The row already says this. It was written before the POST, at `sent` and uncertain, which is
          // where a manual pledge waits after its donor says they have sent it: the slot is held, both
          // dashboards show it, and the owner settles it -- they confirm if the credits arrived and cancel
          // if they never did. Only they, for an API pledge, because cancelling frees the donor's slot and
          // a transfer that did go through would then be sent a second time.
          //
          // So nothing here has to establish that state, and the block that used to -- a write, then a
          // re-read to work out whether the write had landed, then a message that differed depending on
          // the answer -- is gone. It existed because the record was created at this point, which is
          // exactly when the process may not be alive to create it. transferredAt stays empty: it records
          // the moment this server watched RIPE accept a transfer, and here nothing was watched.
          //
          // Clearing the in-flight marker is still worth attempting, because it is what lets the owner act
          // before the grace window lapses. Best effort: if it fails the window expires on its own.
          pledge.inFlight = false;
          try {
            await savePledge(pledge, pledge.etag);
          } catch (clearErr) {
            logError('Could not clear the in-flight marker on an uncertain transfer', clearErr);
          }
          // totals() counts `pledged` and `sent` alike as pending, so the pre-POST write already put this
          // pledge in the project's reserved total and nothing needs recomputing.
          // Read by the "transfer outcome unknown" alert (infra/monitoring.bicep).
          logEvent('transfer', { outcome: 'uncertain', projectId: id, pledgeId: pledge.id }, 'warn');
          throw new HttpError(
            502,
            `${err instanceof Error ? err.message : 'RIPE Atlas did not answer'}. The credits may still have moved, so check your transaction log at https://atlas.ripe.net/credits/transactions/ before sending again. The pledge is recorded and waiting for the project owner to settle it.`,
            // The row was written before the transfer was issued, so a pledge always exists to be settled.
            // Kept as an explicit field because the screen that follows reads it, and it is now a
            // statement about the design rather than about what this particular request managed to do.
            { transferRecorded: true },
          )
        }

        // Past this point the credits have moved. Nothing below may throw, because there is no
        // longer any failure the donor could usefully act on by retrying.
        pledge.status = 'confirmed';
        pledge.inFlight = false;
        // Narrowing the pessimistic marker set before the POST. Miss this one line and every successful
        // API transfer stores confirmed-and-uncertain, which flips apiTransfer false in publicPledge and
        // takes the "Transferred via API" badge off every pledge on the site.
        pledge.transferUncertain = false;
        // The moment RIPE accepted, not the moment we asked. startedAt anchors the in-flight
        // window, which wants the earlier bound; recording it here would date the acceptance up to
        // the full twenty-second timeout early.
        pledge.transferredAt = new Date().toISOString();
        // The one write that matters: it is what makes `confirmed` durable.
        //
        // Unconditional, and safe to be because savePledge merges and never sends donorName. The deletion
        // sweep can scrub the donor's name while this transfer runs; a whole-row replace here used to
        // write the name taken at the top of this handler back over the scrub (#33). Making it
        // conditional instead would turn that scrub into a 412, then a retry on the same stale version,
        // then a confirmed transfer reported as unrecorded -- a money-path failure to fix a cosmetic one.
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
          logError('Transfer completed but the confirmation could not be written', confirmErr);
          // One more attempt at the same confirmed row, not a reduced one.
          //
          // This used to write back `pledged` with the transfer fields cleared, to get the in-flight
          // marker off the row so the owner could act on it. That produced the worst state on this
          // path: an ordinary-looking pending pledge for a transfer RIPE had already accepted. The
          // owner could cancel it from the project page, which drops the received credits from the
          // totals and releases the donor's slot, and the donor's next pledge would then send the
          // same credits a second time -- the exact failure everything else here exists to prevent.
          //
          // Retrying the confirmation has none of that. It is the same write, every field this
          // request owns, so it is no less likely to land; if it
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
              logError('Could not record a completed transfer on retry either', clearErr);
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
        // Read by the same alert: credits that moved without a confirmed row need a human.
        if (saved) logEvent('transfer', { outcome: 'confirmed', projectId: id, pledgeId: pledge.id });
        else logEvent('transfer', { outcome: 'unrecorded', projectId: id, pledgeId: pledge.id }, 'error');
        if (!saved) {
          apiSaveFailed = true;
          recordWarning = 'Your transfer completed, but recording it here did not. Do not send it again. The project owner can confirm the pledge once the credits arrive. If their dashboard refuses at first, it will accept a minute or two later.';
        }
        try {
          updatedProject = await recomputeProjectTotals(id);
        } catch (err) {
          logError('Transfer completed but project totals could not be recomputed', err);
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
            logError('Could not release a pledge slot after a completed transfer', releaseErr);
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
          logError('Could not read the project owner for a manual pledge', ownerErr);
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
      // When the confirmation did not persist, the stored row is the one written before the POST, which
      // now says sent-and-uncertain rather than pledged. That is a better description of a completed but
      // unrecorded transfer than `pledged` ever was, and it stops the donor being offered Mark sent and
      // Cancel on a pledge whose credits have already gone.
      const reported = apiSaveFailed
        ? { ...pledge, status: 'sent' as const, inFlight: false, transferUncertain: true, transferredAt: '', transactionId: '', transactionUrl: '' }
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
        logError('Unexpected failure before a transfer was issued', err);
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

    // Optional, and only for the owner confirming a manual pledge: a RIPE Atlas key of the owner's
    // own, used for one read of their transactions so the pledge records what actually arrived. It
    // is checked here, before anything is read or written, and refused in every other case rather
    // than ignored, so a key sent by mistake is never quietly carried further than this line.
    const wantsCheck = body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== '';
    const choice = body.transactionId === undefined || body.transactionId === null || body.transactionId === '' ? undefined : String(body.transactionId);
    if (wantsCheck || choice !== undefined) {
      if (!isOwner || status !== 'confirmed' || pledge.method !== 'manual') {
        throw new HttpError(400, 'A RIPE Atlas key is only used when the project owner confirms a manual pledge. Nothing was recorded.');
      }
      if (!wantsCheck) throw new HttpError(400, 'Choosing a RIPE Atlas transaction needs your key, so the site can read the transaction again. Nothing was recorded.');
      if (choice !== undefined && !/^[1-9][0-9]{0,19}$/.test(choice)) throw new HttpError(400, 'Transaction id must be a RIPE Atlas transaction id, a positive whole number');
    }
    const ownerKey = wantsCheck ? assertKeyFormat(body.apiKey) : '';

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
    if (!ok) throw new HttpError(409, `The ${role === 'owner' ? 'project owner' : 'donor'} cannot mark a ${pledge.status} pledge as ${status}. Reload to see where it stands.`);

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
    // What a confirmation records. Unchecked, it is the pledge as made. Checked, it is what the
    // owner's RIPE Atlas log shows arriving, read in this request and never taken from the browser.
    let receivedAmount = 0;
    let amountVerified = false;
    let transactionId = pledge.transactionId;
    let checked: CheckedConfirmation | undefined;
    // Names this request's own receipt reservation, so a refusal releases only that one.
    let receiptToken = '';
    // Held from reading the confirmed total to writing this pledge, so two confirmations on the
    // project cannot both pass the ceiling check (acquireConfirmLock).
    let lockToken = '';
    if (status === 'confirmed') {
      lockToken = await acquireConfirmLock(projectId);
      if (!lockToken) {
        throw new HttpError(409, 'Another pledge on this project is being confirmed right now. Nothing was recorded. Try again in a moment.', { recorded: false });
      }
    }
    let updated: Pledge;
    try {
    if (status === 'confirmed') {
      const liveTotals = totals(await listPledges(projectId));
      const room = maxCredits(project.creditsRequested) - liveTotals.confirmed;
      if (ownerKey) {
        let ledger: ReceiptLedger;
        try {
          ledger = await ownerReceiptLedger(project.ownerId, pledge.id);
        } catch (err) {
          logError('Could not read which RIPE Atlas transactions are already matched', err);
          throw new HttpError(503, 'We could not check this pledge against your other pledges just now. Nothing was recorded. Please try again in a moment.', { recorded: false });
        }
        try {
          checked = await checkReceipt({ key: ownerKey, pledged: pledge.amount, since: Date.parse(pledge.createdAt), used: ledger.used, rivals: ledger.rivals, room, choice });
        } catch (err) {
          const outcome = ((err as HttpError).details as { verification?: VerificationDetails } | undefined)?.verification?.outcome;
          logEvent('receipt-check', { outcome: outcome ?? 'error', projectId, pledgeId: pledge.id });
          throw err;
        }
        logEvent('receipt-check', { outcome: checked.outcome, projectId, pledgeId: pledge.id });
        receivedAmount = checked.amount;
        amountVerified = true;
        transactionId = checked.transactionId;
        // The ledger was read, not locked. Take the arrival atomically before the pledge is written,
        // so a second confirmation racing this one cannot record the same transfer.
        receiptToken = await reserveReceipt(project.ownerId, transactionId, projectId, pledge.id);
        if (!receiptToken) {
          throw new HttpError(409, 'Another request is recording that RIPE Atlas transaction right now. Nothing was recorded. Check again in a few minutes.');
        }
      } else if (pledge.amount > room) {
        throw new HttpError(409, `Confirming this pledge would exceed the project's ceiling of ${OVERFUND_MULTIPLIER}× its request; cancel it instead`);
      }
    }

    // Conditional on the row not having changed since it was read at the top of this handler. The
    // owner and the donor can both be looking at the same `pledged` pledge; without this, each
    // authorises against that snapshot and whichever writes last wins, so a donor's "sent" landing
    // after an owner's "confirmed" would make a settled pledge live again, after its slot had
    // already been released and its credits counted as confirmed.
    try {
      updated = await savePledge({ ...pledge, status, receivedAmount, amountVerified, transactionId }, pledge.etag);
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 412) {
        // Refused outright, so the arrival this request reserved is free again. Any other failure may
        // have written the row, so the reservation stays; if the write did not land, the reservation
        // frees itself once it is older than a request could run (receiptReservationReclaimable).
        if (receiptToken) await releaseReceipt(project.ownerId, transactionId, receiptToken).catch(() => undefined);
        throw new HttpError(409, 'This pledge changed while you were looking at it. Reload and try again.', { recorded: false });
      }
      throw err;
    }
    } finally {
      // Best effort: a lock left behind frees itself (confirmLockStale).
      if (lockToken) await releaseConfirmLock(projectId, lockToken).catch(() => undefined);
    }
    // The pledge is written. Nothing below may turn that into an error: a 5xx here would tell the
    // owner the confirmation may not have happened, and invite one that is refused or, for a
    // different pledge, recorded twice. Both steps repair themselves: totals are marked for the
    // maintenance refresh, and a settled pledge's slot is reclaimable without being released.
    let updatedProject: Project = project;
    try {
      updatedProject = await recomputeProjectTotals(projectId);
    } catch (err) {
      logError('Pledge updated but project totals could not be recomputed', err);
      await patchProject(projectId, { totalsDirty: true }).catch(() => undefined);
    }
    // Confirmed and cancelled are both terminal, so the donor's slot on this project is free again.
    if (status === 'confirmed' || status === 'cancelled') {
      await releasePledgeClaim(projectId, pledge.donorId, pledge.id).catch((err) => logError('Could not release a pledge slot after settling it', err));
    }
    return json({
      pledge: privatePledge(updated),
      project: publicProject(updatedProject),
      // Present only when the owner sent a key: what the check found and recorded.
      verification: checked
        ? { outcome: checked.outcome, pledged: pledge.amount, received: checked.amount, transactionId: checked.transactionId }
        : undefined,
    });
  }),
});
