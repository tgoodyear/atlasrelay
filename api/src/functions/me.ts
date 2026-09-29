import { app, HttpRequest } from '@azure/functions';
import { requirePrincipal } from '../lib/auth';
import { handle, json, readJson } from '../lib/http';
import { Project, anonymizeRetainedNames, deleteProjectPostWindow, deleteUser, ensureUser, listPledges, listProjectsByOwner, patchProject, pledgeRacedDeletion, projectMayHaveRacedDeletion, updateUser } from '../lib/store';
import { email, httpsUrl, str } from '../lib/validate';
import { privateUser } from '../lib/views';
import { logError } from '../lib/telemetry';

app.http('me-get', {
  route: 'me',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    const user = await ensureUser(p.userId, p.identityProvider, p.userDetails);
    return json({ user: privateUser(user), principal: { provider: p.identityProvider, roles: p.userRoles } });
  }),
});

app.http('me-put', {
  route: 'me',
  methods: ['PUT'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    await ensureUser(p.userId, p.identityProvider, p.userDetails);
    const body = await readJson(req);
    const patch: Record<string, string> = {};
    const displayName = str(body, 'displayName', { max: 80 });
    if (displayName !== undefined) patch.displayName = displayName || p.userDetails;
    const atlasEmail = email(body, 'atlasEmail');
    if (atlasEmail !== undefined) patch.atlasEmail = atlasEmail;
    const affiliation = str(body, 'affiliation', { max: 120 });
    if (affiliation !== undefined) patch.affiliation = affiliation;
    const url = httpsUrl(body, 'url');
    if (url !== undefined) patch.url = url;
    const user = await updateUser(p.userId, patch);
    return json({ user: privateUser(user) });
  }),
});

app.http('me-delete', {
  route: 'me',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: handle(async (req: HttpRequest) => {
    const p = requirePrincipal(req);
    // Pledging to a project whose owner is gone cannot work: the handler needs the owner's RIPE
    // address to name a recipient. Leaving them open would advertise projects that fail at the
    // moment a donor tries to give to them.
    // One project that will not close must not stop the rest. Aborting the sweep left every later
    // project open and still returned success, against a page that promises they are all closed.
    const closeOpen = async (owned: Project[]): Promise<{ closed: number; failed: number }> => {
      const open = owned.filter((x) => x.status === 'open');
      let closed = 0;
      let failed = 0;
      for (const project of open) {
        try {
          await patchProject(project.id, { status: 'closed' });
          closed += 1;
        } catch (err) {
          failed += 1;
          logError(`Could not close project ${project.id} while deleting its owner`, err);
        }
      }
      return { closed, failed };
    };

    // The profile goes first. Sweeping projects is serial work that grows with the person's history,
    // and letting it run ahead of the delete means a person with many projects could have the
    // request time out with their RIPE address still stored, against a page that promises deletion
    // outright. Removing the row first makes the promise unconditional; the sweep is cleanup.
    const deletedAt = Date.now();
    await deleteUser(p.userId);

    // The posting window goes with it. That row is keyed by account id, so keeping it would mean
    // retaining an identifier of an account that asked to be removed, against a page that promises
    // removal outright. The cost is stated rather than hidden: deleting and signing in again
    // resets the posting interval, so the limit is a tax on an abuser rather than a wall -- and
    // somebody who will delete their profile to post faster can register another account anyway.
    // Best effort, like everything after the delete: the profile is gone, and that is the promise.
    await deleteProjectPostWindow(p.userId).catch((err) => {
      logError('Profile deleted but its posting window could not be removed', err);
    });

    // Then close what they own. A project left briefly open cannot be pledged to, because the
    // handler needs the owner's address to name a recipient, so the window is a clean failure
    // rather than a disclosure. Projects written after this sweep close themselves: creation and
    // reopening both re-check for the owner after writing.
    let owned: Project[] | null = null;
    try {
      owned = await listProjectsByOwner(p.userId);
    } catch (err) {
      logError('Profile deleted but its projects could not be listed', err);
    }

    let closed = 0;
    let failed = 0;
    if (owned) {
      try {
        ({ closed, failed } = await closeOpen(owned));
      } catch (err) {
        logError('Profile deleted but its projects could not be swept', err);
        failed = -1;
      }
    } else {
      failed = -1;
    }

    // Then find pledges that got to the address first (#20). After the close, not before: closing is
    // what stops new pledges, and this scan reads pledge rows, which are never pruned, so it is the
    // slow part. It works from the snapshot taken before the close, which still says which projects
    // were open.
    //
    // A pledge in flight when the profile row went may already have read the address, and nothing here
    // can call a transfer back.
    // The pledge handler stores its row before it reads the owner, and this runs after the owner is
    // gone, so a pledge that read the address in time is stored by now and this sees it; one that
    // reads after this point finds no address and sends nothing. What that buys is an honest answer:
    // the response says a transfer or a disclosure was already under way, rather than promising the
    // address is out of use while credits are on their way to it. Null when the check could not run,
    // which the page reports as not knowing rather than as none.
    let pledgesInFlight: number | null = null;
    if (owned) {
      try {
        let n = 0;
        for (const project of owned.filter((x) => projectMayHaveRacedDeletion(x, deletedAt))) {
          n += (await listPledges(project.id)).filter((x) => pledgeRacedDeletion(x, deletedAt)).length;
        }
        pledgesInFlight = n;
      } catch (err) {
        logError('Profile deleted but pledges in flight could not be checked', err);
      }
    }

    // Then take the name off what survives. Projects and pledges are kept on purpose -- donors and
    // researchers rely on that record -- but the name copied onto them at creation is the profile, and
    // deleting the profile should mean it goes. Names are snapshots: nothing joins these rows back to the
    // users table, so removing that row on its own left the name on every card and every pledge line.
    //
    // After the close, not before. Closing is what stops a project taking credits nobody can receive, so it
    // is the part worth spending the request's remaining time on first; a name is a slower harm than a
    // pledge to a researcher who cannot be paid.
    let named = { projects: 0, pledges: 0, failed: 0 };
    try {
      named = await anonymizeRetainedNames(p.userId);
    } catch (err) {
      logError('Profile deleted but its retained names could not be anonymized', err);
      named = { projects: 0, pledges: 0, failed: -1 };
    }
    // The profile is gone either way, which is the promise that matters and the one the page
    // makes. Say so separately from whether every project got closed, rather than reporting a
    // clean result over a sweep that did not finish. A project left open cannot be pledged to,
    // and creation and reopening both re-check for the owner, so it fails cleanly rather than
    // taking credits nobody can receive.
    return json({
      deleted: true,
      projectsClosed: closed,
      projectsNotClosed: failed === -1 ? null : failed,
      namesAnonymized: named.projects + named.pledges,
      namesNotAnonymized: named.failed === -1 ? null : named.failed,
      // Kept out of sweepComplete: that flag is about cleanup this request can finish or retry, and a
      // transfer already sent to RIPE is neither. Zero is the only value the page may log out on.
      pledgesInFlight,
      // One flag for the whole cleanup. A row that kept its name is as unfinished as a project that
      // stayed open, and reporting a clean sweep over either would be the thing this field exists to
      // stop. The profile itself is gone regardless, which is the promise `deleted` carries.
      sweepComplete: failed === 0 && named.failed === 0,
    });

  }),
});
