# Atlas Relay architecture

A small donation board where RIPE Atlas users who need measurement credits post a
project, and users who have spare credits send them. Donors give credits and get nothing
back. Transfers happen in RIPE Atlas and the site never holds credits; the site stores
the project, the pledge and its confirmation.

## Goals and constraints

| Goal | Decision |
| --- | --- |
| Simple UI | Single-page React app with a handful of screens. |
| Serverless | Azure Static Web Apps (Standard) + an Azure Function App on the Flex Consumption plan, linked to the site as its API + Azure Table Storage + App Insights. |
| CI/CD from GitHub | GitHub Actions workflows for the app deploy (build and test on PRs, deploy on push to `main`, logging in with OIDC through a user-assigned managed identity; no Azure secrets are stored in GitHub), infra checks (Bicep lint on PRs and `main`), and the full-flow tests on dev, which run in Azure. The infrastructure itself is one deployment stack per environment, deployed by a subscription Owner. |
| Identity | GitHub or Microsoft sign-in via Static Web Apps built-in auth. RIPE NCC Access OIDC is not obtainable for third parties today (see `RIPE-ATLAS-NOTES.md`); the design leaves a slot for it. |
| Never custody credits or keys | Transfers happen on RIPE's side. API keys supplied by donors are used for one request and discarded; nothing key-like is written to storage or logs. |

## System diagram

```
 Browser (React SPA)
   │  /.auth/login/github | /.auth/login/aad      (SWA built-in auth, free)
   │  /api/*  (x-ms-client-principal injected by SWA edge)
   ▼
 Azure Static Web Apps (Standard) ── linked backend: Function App (Flex Consumption,
   │                                   Node 24, HTTP only; refuses requests the site
   │                                   did not send)
   │ static assets (global CDN)         │ @azure/data-tables, managed identity
   │                                    ▼
   │                          Azure Storage account (Standard LRS, no shared keys)
   │                             tables: users, projects, pledges, claims
   │
   └── donor-initiated transfer ──▶ https://atlas.ripe.net/api/v2/credits/transfers/
                                     Authorization: Key <donor key, single use>
```

## Domain model

### User (`users` table, PK `user`, RK `<swa userId>`)

| Field | Notes |
| --- | --- |
| `provider`, `handle` | From the SWA client principal (`github`/`aad`, username or email). |
| `displayName` | Shown publicly next to projects and pledges. |
| `atlasEmail` | RIPE NCC Access email. **Private.** Required to publish a project. Only revealed to a donor who has created a pledge for that project. |
| `affiliation`, `url` | Optional public profile fields. |
| `createdAt`, `updatedAt` | ISO timestamps. |

### Posting window (`users` table, PK `project-post`, RK `<swa userId>`)

One row per account that has posted a project, holding `lastProjectAt`. It is taken before the
project row is written, by creating the row or by replacing it conditionally on its version, so a
burst of concurrent posts has exactly one winner rather than all of them passing a count. It sits
in its own partition rather than on the user row, because a second writer there would collide with
the conditional replace `PUT /api/me` uses and make a concurrent profile save report the profile as
gone. `DELETE /api/me` removes it with the profile: it is keyed by account id, so keeping it would
retain an identifier of an account that asked to be removed.

### Owner index (`projects` table, PK `owner-<swa userId>`, RK `<project id>`)

One small row per project an account has posted, written before the project row and never changed
afterwards. It is how the open-project cap and `DELETE /api/me` find an owner's projects: a keyed
partition read plus a point read per project, instead of a filter on `ownerId` over every project on
the site. Membership only; status is always read from the project row, so a close or a takedown
made directly in storage cannot leave the index disagreeing about the cap. Every other projects
query filters on `PartitionKey eq 'project'`, so these rows never appear in the listing.

### Project (`projects` table, PK `project`, RK `<id>`)

| Field | Notes |
| --- | --- |
| `ownerId`, `ownerName` | Denormalized owner display name for listing. |
| `title` (≤120), `summary` (≤280), `description` (≤8000, plain text with paragraphs) | |
| `creditsRequested` | Integer 1..1e9. |
| `creditsConfirmed`, `creditsPending` | Cached sums recomputed from pledges after every pledge change. |
| `status` | `open` \| `closed`. `funded` is derived and does not stop pledges. Whether a project is *listed* depends on confirmed credits alone, so a pending pledge can never hide it. A pending pledge reserves capacity for `PENDING_RESERVATION_DAYS` (14) and then stops counting, so an abandoned pledge releases what it held. |
| `tags` | Subset of: ping, traceroute, dns, sslcert, http, ntp, ipv4, ipv6, anchors, other. |
| `affiliation`, `homepageUrl`, `repoUrl`, `paperUrl`, `deadline` | Optional. |
| `resultsSummary` (≤4000, plain text), `resultsUrl` | What came of the work, posted by the owner after the credits were spent. Kept separate from `paperUrl`, which is the proposal that justified the ask. Both public. |
| `resultsPostedAt` | ISO, stamped the first time either of the two above goes non-empty and never cleared afterwards, so a write-up that is later edited away does not retract the fact that the researcher reported. `hasResults` is derived from it in `publicProject`, and the listing filter, the card pill and the home-page `projectsWithResults` count all read that one flag. Absent on rows written before the fields existed, which reads as empty. |
| `createdByTests` | `true` on a project created on a test environment, while `E2E_PROJECT_CLEANUP` is on, with a title starting `E2E ` (the title the full-flow tests use). Stored at creation and never written afterwards. It is what lets `DELETE /api/test/projects/{id}` remove the project. Absent everywhere else, prod included. Never published. |
| `deletingSince` | ISO, written by `DELETE /api/test/projects/{id}` when it closes a project to delete it; the deletion waits until it is two minutes old, and the project cannot be reopened meanwhile. Never published. |
| `createdAt`, `updatedAt` | |

Whether a project reported back is not a `status` value. Whether it still wants
credits and whether it published anything are orthogonal, and a closed project that reported is a
different thing from a closed one that did not.

### Pledge (`pledges` table, PK `<projectId>`, RK `<id>`)

| Field | Notes |
| --- | --- |
| `donorId`, `donorName` | |
| `anonymous` | The donor asked not to be named publicly. `publicPledge` replaces the name with the constant `Anonymous`; `privatePledge`, which only the project owner and the donor themselves receive, restores it and keeps this flag set so the UI can say the name is not public. Absent on rows written before this existed, which reads as false. |
| `amount` | Integer ≥ 1. Capped two ways: by the project's remaining *capacity* (100× the request, minus confirmed, minus live reservations) and by `maxSinglePledge`, which is what is left to the goal, or one goal's worth once the goal is met. The second cap stops any one pledge reserving the whole ceiling. |
| `method` | `api` (transfer executed by our function with the donor's key) or `manual` (donor transfers on atlas.ripe.net). |
| `status` | `pledged` → `sent` → `confirmed`; or `cancelled`. An `api` pledge goes straight to `confirmed` because our server observed RIPE accept the transfer, which is recorded in `transferredAt`. |
| `transactionId` | Empty on new pledges. RIPE does not index a transaction until well after it accepts the transfer (measured live: absent immediately, present 40 to 70 seconds later), so it cannot be looked up inside the request, and this platform has no background worker to do it later. The transfer endpoint's own response carries only a generic list URL, identical for every transfer, so it is not a reference either. Older rows may hold a value. |
| `transactionUrl` | Empty on new pledges, for the same reason as `transactionId`: there is no lookup left to build a link from. Rows created before that change may hold a link to a matched transaction, or the generic list URL the transfer endpoint returned. |
| `message` | Optional public note from the donor. |
| `createdAt`, `updatedAt` | |

Pending = `pledged` + `sent`. Confirmed = `confirmed`. Both are recomputed by summing
the partition after each change, so the project row never drifts.

## Flows

### Requester
1. Sign in (GitHub or Microsoft).
2. Complete profile: display name + RIPE NCC Access email (validated, private).
3. Create project: title, one-paragraph summary, description, credits needed, tags,
   optional links and deadline. Publish.
4. Watch pledges arrive; confirm manual pledges once credits show up at
   https://atlas.ripe.net/credits/ (transactions list). Optionally paste a key of their own
   with only "Get information about your credits" when confirming; see
   [Checking a manual pledge](#checking-a-manual-pledge). Close the project when done.

### Donor
1. Open a project, click **Send credits**, pick an amount. It defaults to what is left toward the goal, and is bounded by `maxSinglePledge`: what is left to the goal, or one goal's worth once the goal is met. A project accepts up to 100× its request in total, but no single pledge may reserve that whole ceiling.
2. Choose one:
   - **Transfer now with an API key**: the donor pastes a key created at
     https://atlas.ripe.net/keys/ with two permissions, "Transfer credits to another
     user" and "Get information about your credits", the latter so the balance can be
     checked before sending. A transfer-only key works too: the balance read is still
     attempted for every key, RIPE refuses it, and the transfer proceeds with a warning
     that the balance could not be checked. So a pasted key makes at most two RIPE
     requests, and sometimes one: a balance that comes back below the amount stops the
     request there, with nothing sent. The pledge row is written **before** the transfer and
     marked `sent` and uncertain, then the function calls `POST /credits/transfers/` exactly
     once. On 201 the pledge becomes `confirmed` and `transferredAt` records when we saw
     RIPE accept it. If that write fails the handler retries it and, failing that, re-reads
     the row, so a write whose response was merely lost still ends up reported as
     confirmed. If the confirmation never persists, the row stays `sent` and uncertain,
     the response warns the donor not to send again, and the requester confirms it once
     the credits arrive.
     No transaction reference is attached: RIPE indexes the transaction well after
     accepting the transfer, so it cannot be read back inside the request, and the
     donor's own credit log shows it a minute or so later. If RIPE never answers, the pledge is left at
     `sent` and flagged uncertain, keeps the donor's slot, and waits for the requester
     to settle it. It is exempt from the 14-day reservation expiry, so its capacity and the
     donor's slot stay held until the requester confirms or cancels it.
     The key lives only in the request scope, and the UI tells donors to delete or disable
     it afterwards.
   - **I'll transfer on atlas.ripe.net**: we show the recipient email and amount with
     a link to https://atlas.ripe.net/credits/transfer/. The pledge is `pledged`; the
     donor marks it `sent`; the requester marks it `confirmed`.
3. Donor's pledges are listed on their dashboard.

### Checking a manual pledge

A manual pledge records what the donor said they would send. The donor transfers on
atlas.ripe.net, where the site cannot see it, and may send a different amount. When the owner confirms,
they may paste a key of their own with only "Get information about your credits". The API reads
`GET /credits/transactions/?sort=-date&type=admin&page_size=100` once with it, keeps nothing of the
key, and looks for the arrival.

RIPE's rows carry `id`, `type`, a signed `amount`, `date` in epoch seconds, `reason`,
`description` and balances. No documented field names the other account. In practice the
`description` reads "from" and an email address, but the format is undocumented and the site does
not know a donor's RIPE NCC Access email, so a row is not tied to a donor. A row is a candidate when it is `admin`, its amount is positive (credits in), it is no
older than the pledge (to the second, since RIPE stamps whole seconds), and its id is not already
recorded against another pledge on any of the owner's projects.

A candidate is *contested* when another of the owner's pledges of the same amount, with no RIPE
transaction id recorded, could account for it: a pledge still waiting (its donor may have sent), an
API transfer (the server never looks its row up), or a manual pledge confirmed without a check. A
waiting pledge could account for any arrival after it was created; a confirmed API transfer, any
arrival from its creation to a minute after the server saw RIPE accept it (a row is dated when the
transfer happened); any other confirmed pledge, any arrival from its creation to ten minutes after
it was last updated. Then:

| Candidates | What happens |
| --- | --- |
| Exactly one of the pledged amount, not contested | Confirmed, verified, with RIPE's transaction id. Other amounts beside it are ignored. |
| One, of another amount | 409. The owner sees "RIPE Atlas shows N credits arrived since this pledge was made (pledged M)" and chooses to record N, confirm M unchecked, or wait. |
| Several, a contested one, or the page may be incomplete | 409 with the list, contested rows marked and none preselected. The owner picks one, or confirms M unchecked. Nothing is guessed. |
| None | 409. The row may not be indexed yet (RIPE lists a transfer some time after it happens). Check again, or confirm M unchecked. |
| Key refused (401/403) | 400 naming the permission. Nothing recorded. |
| RIPE does not answer | 409. Nothing recorded. Check again, or confirm M unchecked. Confirming is final, so the site does not confirm for the owner when the read times out. |

A row the owner picks is read again in the request that records it, and has to pass the same
tests, so the browser never supplies an amount. Recording never takes the project past its 100×
ceiling: if what arrived would, the owner is told and offered M unchecked when M fits, or cancel.
A project already at its ceiling is refused before the key is sent. What arrived is not held to the
per-pledge maximum, which limits what a donor may reserve, not what can be recorded as received.

The pledge keeps `amount` (what was pledged) and gains `receivedAmount` (what arrived, 0 when
unchecked), `amountVerified`, and RIPE's id in `transactionId`. Totals count `receivedAmount`
when it is set and `amount` otherwise, and the public pledge shows the counted amount, the pledged
one when they differ, and a "Verified with RIPE Atlas" marker when `amountVerified` is set. Rows written before these fields read as unchecked.

### Ordering, and what happens when a transfer fails

Table Storage has no transaction that can span a local write and a call to RIPE, so the order of
the two decides which way a failure hurts. The pledge row is written first. An orphan row is a
pledge somebody cancels; a transfer with no row is credits nobody can account for.

Before either happens, the donor takes a slot in the `claims` table, one row per (project, donor).
Reading the pledge list and then writing cannot enforce one live pledge per donor, because a
request that reads before a rival writes sees nothing to conflict with and both proceed. Creating
a single row, though, is atomic: exactly one caller creates a given key and the rest get a 409.
A slot is reclaimable once its pledge has settled, or after the reservation window, so a release
that never ran cannot lock a donor out for good. The exception is a pledge whose transfer outcome
is unknown, which holds its slot until the requester settles it.

Reserved capacity is still settled after the write, because it spans different donors and no one
row can arbitrate between them. That is safe where a double transfer would not be: over-reserving
only holds pending credits, it is re-checked at confirm time, and it expires.

What happens next depends on whether RIPE answered.

| Outcome | What we know | What the platform does |
| --- | --- | --- |
| 201 | The credits moved | Pledge becomes `confirmed`, with `transferredAt` as the record |
| 4xx or 429 from RIPE | RIPE refused, nothing moved | Pledge is cancelled, the donor sees why and can try again |
| Timeout, network failure, or a 5xx | Unknown | Pledge is parked at `sent` and flagged uncertain |

An uncertain pledge sits at `sent` on both dashboards, showing "Sent, outcome unknown" rather than
a badge claiming a transfer we never saw succeed. The donor is sent to
https://atlas.ripe.net/credits/transactions/ to check before sending anything again, and the dialog
gives them no way to resubmit.

Only the requester settles it, by confirming or cancelling. This is the one place an API pledge
differs from a manual one, and the asymmetry is deliberate: cancelling frees the donor's slot, so
if the transfer did complete, the donor's next pledge would send the same credits a second time.
The donor can read their own transaction log, but acting on it here has a side effect they cannot
see, whereas either answer the requester gives is safe. The donor's part is to check the log and
tell them what they find.

Once the credits have moved, nothing in the handler is allowed to fail the request. The row
update is best-effort, because a retry at that point would send the credits twice; a confirmation
that did not persist is reported as a warning on a pledge the owner can still confirm.

### Abuse limits

- An account may hold 3 open projects at once. Posting is free, and every project hands its
  owner's contact address to anyone who starts a pledge. Closing one frees a slot. The cap is
  settled after the write rather than checked before it, because a count read before a write cannot
  enforce anything, and closing the surplus is best effort: what the poster is told comes from the
  rows the settlement observed, so a close that did not land is reported as a project that is live
  rather than as a post that was refused. An account can therefore sit one over the cap until its
  next create or reopen re-derives the surplus.
- An account may post one project a minute. The cap above limits open projects, not rows, and it
  closes the surplus itself, so a loop of posts needs no close step to leave a permanent row per
  request. Owner lookups go through the owner index (below), so those rows slow only the account
  that posted them, but every one is still served on the listing. The limit is held as a row, for
  the same reason the pledge claim is. It bounds the rate, not the total: nothing prunes closed projects, so a table already
  grown stays grown.
- A donor may hold one live pledge per project. Without it, one account could reserve a project
  repeatedly and re-read the owner's contact address at will. The limit is the `claims` row
  described under [Ordering](#ordering-and-what-happens-when-a-transfer-fails).
- No single pledge may reserve a project's whole ceiling, so one free account cannot block every
  other donor.
- Reservations expire after 14 days, so the site heals without a background job. Pledges whose
  transfer outcome is unknown are the exception and wait for the requester.
- Listing and statistics key off confirmed credits, so reservations never affect what is visible.

### Privacy

The RIPE NCC Access email is the one piece of personal data the platform holds that matters. It
never appears on an anonymous endpoint. A signed-in donor sees it when they begin a manual
pledge, because they need it to transfer the credits, and the owner sees that donor by name
against the pledge. `DELETE /api/me` removes the profile and the address; projects and pledges
remain, carrying only the chosen display name, because other people rely on that record.

Sign-in handles are never returned publicly. Static Web Apps fills `userDetails` with the email
address for some identity providers, and that value seeds both the handle and the initial display
name, so `publicName()` reduces anything email-shaped to its local part before it leaves the API.

Browser telemetry (page views, load times, errors, the page's API calls and five named actions)
goes to App Insights with no cookies, nothing stored in the browser, and no user id. Query strings,
the referrer's path, and anything shaped like an API key or email address are removed before it is
sent. Each page view carries the referring site's origin (or `direct` / `internal`) and, when the
landing URL had them, `utm_source`, `utm_medium` and `utm_campaign`, lowercased, redacted the same
way and cut to 64 characters. The actions (`pledge-started`, `pledge-completed`, `project-posted`,
`sign-in-clicked`, `outbound-click`) carry the route, public project ids, the pledge method, the
amount as a power-of-ten range, the sign-in provider or an atlas.ripe.net path, and nothing about
the person.
The public page `/privacy` (`web/src/pages/Privacy.tsx`) tells visitors the same. See
[Monitoring](RUNBOOK.md#monitoring) and [Traffic](RUNBOOK.md#traffic).

### Trust model
- Requester identity is a GitHub/Microsoft account plus a self-declared RIPE email.
  We cannot verify the email against RIPE without federation. Mitigations: the email is
  only shown to committed donors; API transfers fail loudly if the email is not a RIPE
  NCC Access account (RIPE returns 4xx); projects display the owner's display name and
  creation date; abuse is handled by closing projects (see the runbook).
- Donor keys: single request, never persisted, never logged. The function also refuses
  to proceed if the key would be echoed in any error path.

## API (`/api/*`, a Function App linked to the site)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/me` | user | Profile + client principal. Creates the user row on first call. |
| `PUT /api/me` | user | Update `displayName`, `atlasEmail`, `affiliation`, `url`. |
| `DELETE /api/me` | user | Delete the profile, including the stored RIPE NCC Access email. |
| `GET /api/projects?status=open&tag=dns&q=` | public | List. `status` is `open`, `funded`, `closed`, `results` or `all`. Never includes emails or projects an operator took down. |
| `GET /api/projects/{id}` | public | Detail + public pledge feed (donor name, amount, status, message), and `page`, the title and description the project page's head carries. 404 for a project an operator took down, except to its owner. |
| `POST /api/projects` | user (needs `atlasEmail`) | Create. 429 when the account posted less than a minute ago; 409 when the open-project cap closed this project again. |
| `PATCH /api/projects/{id}` | owner | Edit fields or set `status`. |
| `GET /api/projects/{id}/pledges` | owner or donor | Owner: all pledges. Donor: own. |
| `POST /api/projects/{id}/pledges` | user, not owner | `{amount, method, message, anonymous?, apiKey?}`. `anonymous` must be a real boolean when present; it withholds the donor's name from public views. Returns pledge and, for `manual`, the recipient email. |
| `PATCH /api/pledges/{projectId}/{id}` | donor or owner | Donor: `sent`/`cancelled`. Owner: `confirmed`/`cancelled` (for stale pledges). On a manual pledge the owner may add `apiKey` (their own key) and, after a first answer, `transactionId`; see [Checking a manual pledge](#checking-a-manual-pledge). Answers 409 with `details.verification` when the owner has to decide. |
| `GET /api/my` | user | My projects + my pledges. |
| `GET /api/stats` | public | Totals for the home page. |
| `POST /api/atlas/balance` | user | `{apiKey}` → `{current_balance,...}` from RIPE. Never stored. |
| `GET /api/sitemap` | public | Sitemap XML of the public pages and every project not taken down. Served at `/sitemap.xml` by a rewrite in `staticwebapp.config.json`. |
| `GET /api/project-page` | public | HTML for `/projects/{id}` and `/projects/{id}/edit`, reached by a rewrite of `/projects/*`. See [Pages and routing](#pages-and-routing). |
| `DELETE /api/test/projects/{id}` | owner; test environments only | Deletes a project marked `createdByTests`, with its pledges and claim rows. Exists only where `E2E_PROJECT_CLEANUP=1`, which is never prod; see [Test cleanup](#test-cleanup). Not in the `staticwebapp.config.json` route rules; the handler alone checks sign-in. |

Authorization is enforced twice: `staticwebapp.config.json` route rules require the
`authenticated` role on mutating routes, and every function re-checks the decoded
`x-ms-client-principal` header and ownership. The functions can trust that header because only
the site reaches them: linking the Function App to the site adds an identity provider, "Azure
Static Web Apps (Linked)", to the app's App Service authentication, and it refuses every request
the site did not send, a forged header included. The Deploy workflow checks this after every
deploy. While an environment's app is not linked (only while relinking it or checking a new app), Bicep
sets `IGNORE_CLIENT_PRINCIPAL=1` and the API treats every request as anonymous. Static Web Apps only supports a wildcard
at the end of a route, so `GET /api/projects/{id}/pledges` is protected in code only
(it returns a JSON 401). There is no global 401 redirect: API calls get JSON errors and
the SPA shows its own sign-in prompt.

## Pages and routing

`web/public/staticwebapp.config.json` maps every page URL to a file or a function. The first
matching rule wins, and there is no navigation fallback.

| Path | Served by | Status |
| --- | --- | --- |
| `/` | `index.html` | 200 |
| `/projects` | `shell/projects.html` | 200 |
| `/projects/new`, `/dashboard`, `/profile` | `shell/app.html` (noindex) | 200 |
| `/projects/*` | `project-page` function | 200 or 404, see below |
| `/how-it-works` | `shell/how-it-works.html` | 200 |
| `/privacy` | `shell/privacy.html` | 200 |
| `/sitemap.xml` | `sitemap` function | 200, or 503 when storage fails |
| anything else | `404.html` (noindex) | 404 |

The build writes the `shell/*.html` files and `404.html` from `web/index.html`, each with its own
head (`web/src/lib/pages.ts`). A static file cannot name a project, so project pages come from a
function:

1. A browser, crawler or link preview fetcher asks for `/projects/{id}`.
2. SWA rewrites the request to `/api/project-page`. A rewrite cannot carry the id, so the
   function reads it from `x-ms-original-url`, which SWA sets to the URL that was asked for.
3. The function accepts only `/projects/{id}` and `/projects/{id}/edit` where the id is 12 to
   32 lowercase letters and digits. Anything else is a 404 without a storage read.
4. It reads the project row. A missing project, or one an operator took down, is a 404 with
   `404.html` for everyone, since the function does not look at who is signed in. The rule is
   `isPublicProject` in `api/src/lib/views.ts`, which the sitemap and the listing also apply.
   `GET /api/projects/{id}` applies it to everyone except the project's owner, so a signed-in
   owner still sees a taken-down project in the app.
5. For a public project it returns `shell/project.html` with the project's title and summary in
   `<title>`, the meta description, the Open Graph and Twitter tags, and the text inside
   `#root`, plus a canonical URL and `og:url` on `https://atlasrelay.org`. Every value is
   HTML-escaped, and descriptions are cut to 200 characters.
6. The browser loads the app from the same page. `GET /api/projects/{id}` returns the same title
   and description as `page`, and the app sets them with `usePageMeta`, so the head does not
   change when the app loads.

The function starts from `shell/project.html` and `404.html` as the same build wrote them.
`api/bundle.mjs` embeds both files in the API bundle, so the page always names the script and
style files deployed with it, and serving a page needs no extra request. The deploy workflow
fails if the bundle does not name the built script file. Storage errors, and a request without
`x-ms-original-url`, get the plain project shell with `noindex` and `no-store`, so the app still
loads and fetches the project itself. SWA does not apply `globalHeaders` to function responses,
so the function sets the same security headers itself.

## Azure resources (every one declared in Bicep)

Each environment is one deployment stack at subscription scope, `atlasrelay-<env>`, deployed from
`infra/main.bicep` by `scripts/bootstrap.sh` or `scripts/provision.sh` (a subscription Owner).
The names below are prod's; `dev` has the same set with `dev` in place of `prod`, no zone, and a
`dev` CNAME in the prod zone.

| Resource | Bicep | SKU |
| --- | --- | --- |
| Resource group `rg-atlasrelay-prod` (westus2) | `infra/main.bicep` | |
| Static Web App `swa-atlasrelay-prod` (staging environments disabled), no app settings | `infra/app.bicep` | Standard |
| Storage account `statlasrelayprod<6 characters>` with tables `users`, `projects`, `pledges`, `claims`; shared keys refused | `infra/app.bicep` | Standard LRS |
| Function App `func-atlasrelay-prod-<6 characters>` (Node 24) on plan `plan-atlasrelay-prod-api`, linked to the site as its backend, with its app settings | `infra/api.bicep` | Flex Consumption, on demand only |
| User-assigned managed identity `id-atlasrelay-prod-api`, the Function App's identity for storage | `infra/api.bicep` | |
| Storage account `stfnatlasrelayprod<4 characters>` for the Functions host and the deployment package (container `deployments`); shared keys refused | `infra/api.bicep` | Standard LRS |
| Log Analytics `log-atlasrelay-prod` (0.1 GB/day cap; App Insights tables kept 90 days, other tables 30) + App Insights `appi-atlasrelay-prod` | `infra/platform.bicep` | Pay-as-you-go |
| Action group `ag-atlasrelay-prod`, five log search alerts, availability test `webtest-atlasrelay-prod-home` and its alert, workbook "Atlas Relay" | `infra/monitoring.bicep` | |
| User-assigned managed identity `id-atlasrelay-prod-ci` + federated credential for the GitHub Environment `prod` | `infra/identity.bicep` | |
| Custom role "Atlas Relay CI Deployer (prod)": read the resource group, the static site and its linked backend, and list the site's deployment token; assigned to the CI identity on the group | `infra/rbac.bicep` | |
| Custom role "Atlas Relay CI API Deployer (prod)": read the Function App and publish a package to it; assigned to the CI identity on the Function App only | `infra/rbac.bicep` | |
| Public DNS zone `atlasrelay.org` with the apex A record, a `www` CNAME to the site, the apex TXT set and mail-rejection records (prod only) | `infra/dns.bicep` | Azure DNS |
| Full-flow test harness (dev only): virtual network `vnet-atlasrelay-dev`, Key Vault `kv-atlasrelay-dev-<6 characters>` (RBAC, public network access disabled) with a private endpoint and the `privatelink.vaultcore.azure.net` zone, test identity `id-atlasrelay-dev-e2e`, results storage `stare2edev<6 characters>` (Entra ID only), container registry `cratlasrelaydev<6 characters>` for the test image (no admin user, no anonymous pull; AcrPull for the test identity only), Container Apps environment `cae-atlasrelay-dev` (Consumption profile, in the network) and job `caj-atlasrelay-dev-e2e` | `infra/testharness.bicep` | Standard vault; Basic registry; Consumption |
| Custom role "Atlas Relay e2e runner (dev)": read and start the test job, read and stop its executions, read two Container Apps log tables; custom role "Atlas Relay e2e image builder (dev)" on the registry: queue an ACR Tasks build and read its status, output image and log; plus Storage Blob Data Reader on the results container; all for the CI identity (dev only) | `infra/testharness-rbac.bicep` | |

The stack deploys with `--action-on-unmanage deleteResources`, so a resource removed from the
templates is deleted on the next deployment, and `--deny-settings-mode denyDelete`, so nobody can
delete a managed resource outside the stack, Owners included. That replaces the `CanNotDelete`
locks the storage account and the site used to carry. Neither setting excludes any principal: CI
deletes nothing, and an Owner who needs to delete by hand deploys once with the deny settings off.

CI deploys no Bicep. Its roles can read the resource group, the site and its linked backend, list
the deployment token the upload action needs, and read the Function App and publish a package to
it. They grant nothing else. A compromised workflow run cannot change RBAC, re-federate the identity,
read or change app settings, touch storage, DNS or monitoring, or delete anything. It can replace
the site's content and the API's code, which is what a deploy is. In dev it can also build the
test image in the registry, start the test job, follow it and read its results and its two log
tables; it has no role on the vault.

### Storage access

No storage account in an environment accepts shared keys (`allowSharedKeyAccess: false`), and
no connection string with a key exists anywhere. Every caller signs in with Microsoft Entra:

| Who | Role | Scope |
| --- | --- | --- |
| API identity `id-atlasrelay-prod-api` | Storage Table Data Contributor | each of the four tables in the data account, one assignment per table |
| API identity | Storage Blob Data Owner, Storage Table Data Contributor | the host account (what the Functions host needs for `AzureWebJobsStorage` and the deployment package) |
| The operator in `ATLASRELAY_OPERATOR_PRINCIPAL_ID` | Storage Table Data Contributor | the data account, for moderation and exports by hand |

The API builds its table client from `TABLES_ENDPOINT` and the identity's client id
(`api/src/lib/tables.ts`). It does not create tables in Azure, since the tables are declared in
Bicep and its role cannot create them. `TABLES_CONNECTION_STRING` is only for local development
and tests against Azurite; nothing in Azure sets it. The Function App's settings still hold the
App Insights connection string. It names the ingestion endpoint, and the browser bundle makes it
public anyway.

`infra/main.bicepparam` reads the environment's settings (`.azure/<env>/.env`, git-ignored) with
`readEnvironmentVariable`; `.azure/env.example` lists them and `scripts/check-params.sh` checks
the two against each other.

Why a managed identity rather than an Entra app registration: the Microsoft Graph Bicep
extension cannot be used from a personal Microsoft account, and the subscription is owned
by one. A user-assigned identity with federated identity credentials is a plain ARM
resource, works with `azure/login`, and needs no directory permissions.

Why the federated subject looks odd: the repository was created after 2026-07-15, so
GitHub issues immutable subjects of the form `repo:OWNER@OWNER-ID/REPO@REPO-ID:…`.
`bootstrap.sh` reads the prefix from the GitHub API and passes it to Bicep, which appends
`:environment:<env>`. `bootstrap.sh` also restricts that GitHub Environment to `main`.

Why no pull-request previews: preview environments would run unreviewed code against the
production tables with a CI identity, so PRs only build, test and lint. Static Web Apps cannot link
a backend to a preview environment either, so a preview would have no API.

Why the Standard plan: only Standard can link a Function App, and a linked Function App is what
lets the API sign in to storage with a managed identity (managed functions have none). Standard
also allows custom OIDC providers, which RIPE NCC Access sign-in would need.

Why Flex Consumption: it takes identity-based host storage with no Azure Files share (on the
Consumption and Premium plans the share's connection needs a key), runs Node 24, scales to zero
and is available in westus2. The table on Microsoft's Static Web Apps page for Azure Functions
lists Consumption, Premium and Dedicated as the plans a linked Function App may use. Flex
Consumption is not on that list. The runbook's cutover checks the Function App directly before the
switch and the main routes through the site right after it, and its rollback puts the managed
functions back.

### Full-flow test harness (dev)

The full-flow tests on dev (`e2e-real/`, runbook "Full-flow tests on dev") sign real Microsoft
accounts into the site and move real credits between two RIPE Atlas accounts, so they need the
accounts' passwords and two live RIPE Atlas API keys. All of these are in a Key Vault with public
network access disabled and RBAC authorization, with the email of each RIPE account beside its
key. The tests run as a Container Apps job in a workload-profiles environment inside the
environment's virtual network; the job reads the vault through a private endpoint, as a
user-assigned identity with Key Vault Secrets User on that vault, and uploads redacted results to a
storage account that accepts only Entra ID. The GitHub workflow `e2e-dev.yml` builds the test image
in the environment's container registry with ACR Tasks, starts the job with it, and downloads the
results. The image is private: the registry has no admin user and no anonymous pull, and the test
identity alone has AcrPull. The CI identity can queue a build, start the job and read the results,
and has no role on the vault. GitHub holds no copy of the passwords or the keys, and the job
redacts them, and the two RIPE account emails, from its logs and results.

dev is one site, one API and one set of tables. Each run deploys the build it tests there, and
keeps every other run off dev until its tests end. The orchestrator (the workflow, or
`scripts/run-e2e.sh` on the owner's machine) takes a 60-second lease on one blob, `full-flow` in
the results account's `locks` container, before it publishes the API and uploads the site, and
renews it every 20 seconds. It starts the job with the lease's id; the job renews the same lease
while its tests run, and the orchestrator releases it at the end. A run that finds it held waits
up to 45 minutes. A lease that nobody renews lapses within a minute, so a run that dies frees dev
on its own, and with only one lock, no two runs can each wait for the other. The
deploy uses the roles the CI identity has in every environment (`infra/rbac.bicep`), on dev's
resources only; `scripts/lib/e2e-job.sh` refuses prod and checks each resource's `environment` tag.
The CI identity, the operator and the test identity have Storage Blob Data Contributor on the
`locks` container, which holds nothing else.

The RIPE keys belong to the harness, not to donors. The site's rule that it keeps no donor's key
is unchanged: the donor key reaches the site the way any donor's would, pasted into the pledge
form, and the site uses it only for the requests that carry it and keeps nothing. The job uses the
recipient key directly with the RIPE Atlas API to check the credits arrived and to send them back,
so each run nets to zero. The test that pledges more than a key holds pays with the key whose
balance is lower, which can be the recipient key; the site handles it like any donor's key and
refuses before sending.

Why a Container Apps job rather than a self-hosted GitHub runner inside the network: the repository
is public, and a self-hosted runner in a public repository can be handed a job by a pull request
from a fork. A job that only Azure can start, from an image the workflow names, needs no runner
listening for GitHub work.

Why the vault, not GitHub secrets: a GitHub secret reaches every step of the job that reads it,
and any code that step runs. In the vault, the test identity reads the passwords and keys from
inside the network. The only other principal with access is the Owner recorded as the operator,
who writes them (Key Vault Secrets Officer, which can read as well) and reaches the vault only
while `scripts/set-test-users.sh` or `scripts/set-ripe-keys.sh` has opened it to their address.

What is trusted: the CI identity chooses the image that runs with the test identity, since it
builds that image in the registry and starts the job with it, and that image can read the
passwords and the RIPE keys. The keys can move real credits out of both RIPE accounts, up to their
balances, for as long as they are valid. Only a workflow run on `main`, by the owner, approved in
the GitHub Environment `dev`, gets the CI identity's token. The passwords belong to throwaway
accounts in a tenant that holds nothing else. A RIPE key works only within the validity window set
when it was created, and can be disabled or deleted at https://atlas.ripe.net/keys/ at any time.

Soft delete is always on for a Key Vault; retention is the 7-day minimum. Purge protection is off:
the vault's name is fixed per environment and `scripts/teardown.sh` purges it, so dev can be
bootstrapped again the same day, and the passwords and keys can be replaced at any time.
The stack's deny settings already stop the vault from being deleted outside the stack.

#### Test cleanup

The site cannot delete a project, so the tests used to leave each run's projects on dev, and the
home-page figures counted them. Each spec now deletes the projects its run
posted through `DELETE /api/test/projects/{id}` (`api/src/lib/testCleanup.ts`), signed in as the
researcher who owns them, whether the test passed or not, and logs the ids it deleted. In the two
specs that move real credits, a hook after the credit return and before the profiles are deleted
closes each test's project, and the deletion is waited for once, after the file's last test; that
later hook also runs when an earlier one timed out, which skips the hooks after it. A run fails if
it could not delete one.

The route exists only where the Function App has `E2E_PROJECT_CLEANUP=1`. `infra/main.bicep` passes
the harness flag to `infra/api.bicep`, which sets the setting only when that flag is true, and the
flag is false whenever the environment is prod. The same key is filtered out of
`additionalAppSettings`. Without the setting the function is not registered, and the handler also
answers 404 before reading the request. Where it exists it deletes a project only for its owner, and
only when the project carries `createdByTests`, which the API stores at creation when the setting is
on and the title starts with `E2E `. It takes two calls. The first closes the project, stamps
`deletingSince` and answers 409, and from then on no new pledge starts. The second deletes, but
only once the stamp is two minutes old: a pledge request that read the project as open just before
the close may still take a slot and transfer, and two minutes is the bound on a running request
that the pledge slots and the confirmation lock already rely on. The edit form cannot reopen a
project while it waits, and if a reopen slipped in anyway the next call starts the wait again. As a
last guard it also refuses while a transfer is in flight or a slot taken in the last two minutes has
no pledge row yet, and it deletes only after a conditional write on the version it checked; the
project row itself is then deleted only at the version that write produced. It
writes a tombstone in the claims table (`cleanup-<id>`) before deleting anything and removes it
last, so the owner can finish a cleanup that failed part way by calling again, even once the
project row is gone. It deletes the pledges, the donors' pledge slots, the
confirmation lock and the owner's receipt reservations naming the project, then the project row.
The owner index entry goes after the project row, because an entry with no project behind it is
skipped by every reader.
It then sweeps the pledges and slots once more, for a pledge made while it ran. Nothing else stores
a figure derived from a project: the home-page figures, the listing and the sitemap are computed
from the project rows when they are read.

`scripts/check-params.sh` checks the compiled templates (prod's parameters turn the harness off,
and the setting depends on nothing but the harness flag), and `api/test/testCleanup.test.ts` checks
the gate, the owner and marker rules and the Bicep sources.

`scripts/purge-test-data.sh <env>` removes what the test accounts left before this existed. It is
for test environments only and refuses prod. It finds the accounts from the projects the tests
posted and works on the tables directly, signed in as the operator. It is a dry run unless given
`--apply`.

## Repository layout

```
web/      Vite + React + TypeScript SPA; public/staticwebapp.config.json
api/      Azure Functions v4 (Node 24, TypeScript)
infra/    main.bicep (subscription scope, one deployment stack per environment) and its modules;
          main.bicepparam reads the environment's settings
.azure/   env.example; each environment's settings in .azure/<env>/.env (git-ignored)
scripts/  bootstrap.sh, provision.sh, teardown.sh, settings.sh (lib/env.sh); bind-custom-domain.sh;
          logs.sh; check-params.sh; set-test-users.sh and set-ripe-keys.sh (test accounts and
          RIPE Atlas keys into the dev vault); run-e2e.sh (lib/e2e-job.sh: build the test image,
          start the test job); purge-test-data.sh (remove old test runs' projects, never prod)
e2e-real/ full-flow tests against dev with real Microsoft sign-in and real RIPE Atlas transfers;
          Dockerfile for the job's image
ops/queries/  saved KQL queries that scripts/logs.sh runs against the Log Analytics workspace
.github/workflows/deploy.yml   build + test on PRs; on main, publish the API to the Function App, then upload the site
.github/workflows/infra.yml    Bicep build + lint, settings check, ShellCheck; deploys nothing
.github/workflows/e2e-dev.yml  build the test image, run the full-flow tests on dev in Azure
.github/workflows/e2e-image.yml  build the test image on PRs; pushes nothing
docs/     this spec, RIPE research notes, runbook
```

## CI/CD

- `deploy.yml`, job `build` (no Azure identity): `npm ci -w api -w web`, tests, build
  web (with the repository variable `APPINSIGHTS_CONNECTION_STRING`, which turns on browser
  telemetry) and API, then stage a self-contained `api-deploy/` folder (the bundle, `host.json`
  and `package.json`, published as it is with no remote build), smoke-load the API entry point,
  upload both as artifacts. Runs on PRs too.
- `deploy.yml`, job `browser` (no Azure identity): Playwright tests in `web/e2e` against a
  `vite preview` of the site; they answer `/api`, `/.auth` and App Insights requests themselves.
- `deploy.yml`, job `flows` (no Azure identity, no secrets): full-flow Playwright tests in
  `web/e2e/flows` against the whole application on the runner. Azure Functions Core Tools comes
  from its GitHub release, pinned by version and SHA-256. `web/e2e/flows/harness/stack.ts` starts
  Azurite in memory, the Functions host with the built API bundle, the Static Web Apps emulator
  serving `web/dist`, and a stub of the RIPE Atlas API that the API reaches through
  `ATLAS_API_BASE`. Traces and the stack's logs are uploaded when it fails. `deploy` needs `build`,
  `browser` and `flows`.
- `deploy.yml`, job `deploy` (push to `main` / manual only, in the GitHub Environment `prod`):
  download artifacts, `azure/login` (OIDC, managed identity), find the Function App from the
  site's linked backend (the run stops if there is none), publish the zipped API to it through
  its `/api/publish` endpoint with a Microsoft Entra token and wait for the deployment, read the
  SWA deployment token with `az staticwebapp secrets list` (masked, never stored), upload the
  site with `Azure/static-web-apps-deploy@v1` and an empty `api_location`, then check that direct
  requests to `/api/stats` and `/api/me` on the Function App's hostname, both with a forged
  `x-ms-client-principal`, are refused. The API goes first, so a failed publish leaves the
  previous API and site in place. Between the publish and the upload, project pages from the new
  API reference script files the old site does not serve yet.
- `deploy.yml`, job `indexnow` (after a deploy that uploaded, no Azure identity): runs
  `scripts/indexnow.mjs`, which reads the live `/sitemap.xml` and posts its URLs to IndexNow.
  It logs failures as warnings and is `continue-on-error`, so it cannot fail a deploy.
- `infra.yml`: builds and lints every template (a warning fails it), runs
  `scripts/check-params.sh` and ShellCheck, on PRs and on `main`. It holds no Azure identity.
- `e2e-dev.yml` (push to `main` that touches `e2e-real/`, `web/e2e/ui.ts`,
  `scripts/lib/e2e-job.sh` or the workflow, and manual; never on pull requests; every job checks
  that the repository is `tgoodyear/atlasrelay`, the actor `tgoodyear` and the ref `main`): job
  `build` (no Azure identity) builds the site and the API at the commit and stages the API zip;
  job `run`, in the GitHub Environment `dev` (main only; waits for the owner's approval unless
  `scripts/bootstrap.sh dev` last ran with `--no-approval`), logs in with OIDC as the dev CI
  identity, builds `e2e-real/Dockerfile` in dev's registry with ACR Tasks, takes the full-flow
  lock, publishes the API and uploads the site to dev, starts the Container Apps job with the new
  image pinned by digest and the lock's lease, polls the execution, releases the lock, downloads
  the results from blob storage and uploads only the summary as an artifact (the repository is
  public), reads the job's logs from Log Analytics when the execution failed, and fails unless
  every test passed. It uploads the site by running the Static Web Apps upload client
  (`mcr.microsoft.com/appsvc/staticappsclient:stable`, the image the Deploy workflow's action
  runs) as an ACR Tasks run in dev's registry, with the deployment token as a secret value of the
  run, and installs no packages. It signs az in again with a fresh OIDC token during the run,
  since az cannot renew the first sign-in. Without the repository variable `DEV_ENABLED=true` it only prints a
  notice.
- `e2e-image.yml` (PRs that change `e2e-real/` or `web/e2e/ui.ts`): builds the test image and
  lists the tests inside it. Pushes nothing, holds no identity.
- `deploy.yml` degrades to build-only until bootstrap has run; after that
  (`AZURE_BOOTSTRAPPED` repo variable) a missing secret fails the run instead of
  skipping. Deployments to `main` are serialized (`concurrency`); PR runs have their own
  groups. Third-party actions are pinned to commit SHAs and kept current by Dependabot.
  The SWA deploy action is a Docker action that pulls `staticappsclient:stable`, so its
  SHA pins the wrapper, not the client image.
- The staged API artifact is built from the lockfile (`npm ci -w api --omit=dev`), so
  the tree that ships is the tree that was tested.
- `scripts/bootstrap.sh <env>`: preflight checks, resource-provider registration, reads the
  GitHub OIDC subject prefix (validated against the repository's immutable-subject setting),
  writes the settings, deploys the stack (retried for custom-role replication lag), creates the
  GitHub Environment restricted to `main`, and for prod stores the identity's client id, tenant
  id and subscription id as GitHub secrets plus the `AZURE_BOOTSTRAPPED` and
  `APPINSIGHTS_CONNECTION_STRING` variables. `scripts/provision.sh <env>` redeploys the stack
  from the settings; `scripts/teardown.sh <env>` deletes the environment.

## Security notes

- Global headers: CSP (self, including the self-hosted fonts, and the App Insights ingestion
  endpoints for browser telemetry), HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`.
- Input validation on every write; string lengths, enums, URL scheme allow-list
  (`https:` only), integer ranges.
- Storage accounts: public blob access off, TLS 1.2 minimum, shared-key access off. See
  [Storage access](#storage-access).
- Function App: HTTPS only, FTP and SCM basic-auth publishing off, reachable only through the
  site once linked.
- Secrets: none in app settings. The Function App's settings (Bicep is the only writer; the
  settings resource replaces the whole map) hold account names, endpoints, the identity's client
  id and the App Insights connection string. GitHub holds three non-secret identifiers (client,
  tenant, subscription); the SWA deployment token is fetched per run and masked. Azure login from
  CI is OIDC. Untrusted build steps never run in a job that holds the identity.
