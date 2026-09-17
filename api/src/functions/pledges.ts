import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { assertKeyFormat, getCredits, transferCredits } from '../lib/atlas';
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
      message,
      createdAt: ts,
      updatedAt: ts,
    };

    let balanceWarning: string | undefined;
    let overshootWarning: string | undefined;
    if (method === 'api') {
      const key = assertKeyFormat(body.apiKey);
      // Best-effort balance check. A transfer-only key may lack the read permission; that is fine.
      try {
        const credits = await getCredits(key);
        if (typeof credits.current_balance === 'number' && credits.current_balance < amount) {
          throw new HttpError(400, `Your RIPE Atlas balance is ${credits.current_balance.toLocaleString('en-US')} credits, less than the ${amount.toLocaleString('en-US')} you want to send`);
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400 && /balance is/.test(err.message)) throw err;
        // Most often the key carries "Transfer credits to another user" but not
        // "Get information about your credits", which is worth naming rather than hiding.
        balanceWarning = 'Your balance was not checked first; the key appears to lack the "Get information about your credits" permission.';
      }
      const result = await transferCredits(key, owner.atlasEmail, amount);
      pledge.status = 'confirmed';
      pledge.transactionUrl = result.transaction;
    }

    await createPledge(pledge);
    let updatedProject = await recomputeProjectTotals(id);

    // Table Storage has no cross-partition transactions, so two pledges can pass the checks above
    // at the same moment. Re-check reserved capacity after writing and withdraw the loser. Only a
    // manual pledge can be withdrawn: an API pledge has already moved credits at RIPE and cannot
    // be reversed, so it is always kept and the overshoot is reported instead.
    const ceiling = maxCredits(project.creditsRequested);
    const reserved = updatedProject.creditsConfirmed + updatedProject.creditsPending;
    if (reserved > ceiling) {
      if (method === 'manual') {
        await savePledge({ ...pledge, status: 'cancelled' });
        updatedProject = await recomputeProjectTotals(id);
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
        recipientEmail: method === 'manual' ? owner.atlasEmail : undefined,
        transferUrl: 'https://atlas.ripe.net/credits/transfer/',
        warning: [balanceWarning, overshootWarning].filter(Boolean).join(' ') || undefined,
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
