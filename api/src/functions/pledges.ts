import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, AtlasUnreachable, findTransferTransaction, getCredits, transferCredits } from '../lib/atlas';
import { handle, HttpError, json, readJson } from '../lib/http';
import { isId, newId } from '../lib/ids';
import { activePledgesBy, createPledge, ensureUser, getPledge, getProject, getUser, listPledges, now, Pledge, recomputeProjectTotals, savePledge, totals } from '../lib/store';
import { int, MAX_CREDITS, oneOf, str } from '../lib/validate';
import { acceptsMorePledges, capacity, maxCredits, maxSinglePledge, OVERFUND_MULTIPLIER } from '../lib/pledging';
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
      message,
      createdAt: ts,
      updatedAt: ts,
    };

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
      await savePledge({ ...pledge, status: 'cancelled' });
      await recomputeProjectTotals(id);
      return err;
    };

    // The one-live-pledge and capacity checks above read before writing, so a burst of concurrent
    // requests from the same donor can all pass them. Settle it now that the row is visible:
    // re-read, and where a donor holds more than one live pledge the lowest id wins. Ids are
    // time-prefixed and sortable, so every racing request reaches the same verdict without
    // coordination. Losing costs nothing here, because this runs before the transfer.
    const mine = activePledgesBy(await listPledges(id), donor.id);
    if (mine.length > 1 && pledge.id !== mine.map((x) => x.id).sort()[0]) {
      throw await rollback(new HttpError(409, 'You already have a pledge in progress on this project. Complete or cancel it first.'));
    }

    // Reserved capacity needs the same treatment, because two different donors can pass the
    // capacity check at the same moment.
    let updatedProject = await recomputeProjectTotals(id);
    if (updatedProject.creditsConfirmed + updatedProject.creditsPending > maxCredits(project.creditsRequested)) {
      throw await rollback(new HttpError(409, 'Another donor took the remaining capacity a moment ago. Please try a smaller amount.'));
    }

    let balanceWarning: string | undefined;
    let recordWarning: string | undefined;
    if (method === 'api') {
      const key = assertKeyFormat(body.apiKey);
      // Best-effort balance check. A transfer-only key may lack the read permission; that is fine.
      try {
        const credits = await getCredits(key);
        if (typeof credits.current_balance === 'number' && credits.current_balance < amount) {
          throw new HttpError(400, `Your RIPE Atlas balance is ${credits.current_balance.toLocaleString('en-US')} credits, less than the ${amount.toLocaleString('en-US')} you want to send`);
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400 && /balance is/.test(err.message)) throw await rollback(err);
        // Most often the key carries "Transfer credits to another user" but not
        // "Get information about your credits", which is worth naming rather than hiding.
        balanceWarning = 'Your balance was not checked first; the key appears to lack the "Get information about your credits" permission.';
      }

      const startedAt = Date.now();
      try {
        await transferCredits(key, owner.atlasEmail, amount);
      } catch (err) {
        if (err instanceof AtlasUnreachable) {
          // RIPE may or may not have taken the credits, and there is no way to ask without the
          // donor's key. Park the pledge exactly where a manual one waits after the donor says
          // they have sent it: the owner confirms it if the credits arrive, the donor cancels it
          // if they never do. It stays on both dashboards until somebody settles it.
          pledge.status = 'sent';
          pledge.transferUncertain = true;
          pledge.transferredAt = new Date(startedAt).toISOString();
          try {
            await savePledge(pledge);
            await recomputeProjectTotals(id);
          } catch (saveErr) {
            // The warning below matters more than the row's exact status, so say it either way.
            console.error('Could not park an uncertain transfer:', saveErr instanceof Error ? saveErr.message : saveErr);
          }
          throw new HttpError(
            502,
            `${err.message}. The credits may still have moved, so check your transaction log at https://atlas.ripe.net/credits/transactions/ before sending again. The pledge is recorded and waiting for the project owner to confirm it.`,
          );
        }
        // Everything else is RIPE answering with a refusal, which means no credits moved.
        throw await rollback(err instanceof HttpError ? err : new HttpError(400, 'RIPE Atlas rejected the transfer'));
      }

      // Past this point the credits have moved. Nothing below may throw, because there is no
      // longer any failure the donor could usefully act on by retrying.
      pledge.status = 'confirmed';
      pledge.transferredAt = new Date(startedAt).toISOString();
      try {
        // The transfer endpoint returns a generic list URL, not a per-transfer reference, so look
        // the transaction up to record a real id. A key without the credits-read permission still
        // completes the transfer, it just carries no id.
        const txn = await findTransferTransaction(key, amount, startedAt);
        if (txn) {
          pledge.transactionId = String(txn.id);
          pledge.transactionUrl = `https://atlas.ripe.net/api/v2/credits/transactions/?id=${txn.id}`;
        }
      } catch {
        // No reference beats failing a transfer that already happened.
      }

      try {
        await savePledge(pledge);
        updatedProject = await recomputeProjectTotals(id);
      } catch (err) {
        // The credits are gone and we cannot mark the row confirmed. Leave it pending rather than
        // erroring: it is on both dashboards, and the owner can confirm it by hand.
        console.error('Transfer completed but the pledge could not be updated:', err instanceof Error ? err.message : err);
        recordWarning = 'Your transfer completed, but recording it here did not. The project owner can confirm the pledge once the credits arrive.';
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

    // Confirming must never push confirmed credits past the ceiling, whatever was reserved.
    if (status === 'confirmed') {
      const liveTotals = totals(await listPledges(projectId));
      if (liveTotals.confirmed + pledge.amount > maxCredits(project.creditsRequested)) {
        throw new HttpError(409, `Confirming this pledge would exceed the project's ceiling of ${OVERFUND_MULTIPLIER}× its request; cancel it instead`);
      }
    }

    const updated = await savePledge({ ...pledge, status });
    const updatedProject = await recomputeProjectTotals(projectId);
    return json({ pledge: privatePledge(updated), project: publicProject(updatedProject) });
  }),
});
