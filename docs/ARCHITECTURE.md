# Atlas Relay architecture

A small donation board where RIPE Atlas users who need measurement credits post a
project, and users who have spare credits send them. Donors give credits and get nothing
back. The site never holds credits; RIPE Atlas remains the ledger, and the site stores
the project, the pledge and its confirmation.

## Goals and constraints

| Goal | Decision |
| --- | --- |
| Simple UI | Single-page React app with a handful of screens. |
| Serverless | Azure Static Web Apps (Free) + managed Azure Functions + Azure Table Storage + App Insights. |
| CI/CD from GitHub | Two GitHub Actions workflows: app deploy (build and test on PRs, deploy on push to `main`) and infra (lint on PRs, what-if and deploy on `main`). Both log in with OIDC through a user-assigned managed identity; no Azure secrets are stored in GitHub. |
| Identity | GitHub or Microsoft sign-in via Static Web Apps built-in auth. RIPE NCC Access OIDC is not obtainable for third parties today (see `RIPE-ATLAS-NOTES.md`); the design leaves a slot for it. |
| Never custody credits or keys | Transfers happen on RIPE's side. API keys supplied by donors are used for one request and discarded; nothing key-like is written to storage or logs. |

## System diagram

```
 Browser (React SPA)
   │  /.auth/login/github | /.auth/login/aad      (SWA built-in auth, free)
   │  /api/*  (x-ms-client-principal injected by SWA edge)
   ▼
 Azure Static Web Apps (Free)  ── managed Azure Functions (Node 22, HTTP only)
   │                                    │
   │ static assets (global CDN)         │ @azure/data-tables
   │                                    ▼
   │                          Azure Storage account (Standard LRS)
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
   https://atlas.ripe.net/credits/ (transactions list). Close the project when done.

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

Browser telemetry (page views, load times, errors and the page's API calls) goes to App Insights
with no cookies, nothing stored in the browser, and no user id. Query strings, the referrer's path,
and anything shaped like an API key or email address are removed before it is sent. See
[Monitoring](RUNBOOK.md#monitoring).

### Trust model
- Requester identity is a GitHub/Microsoft account plus a self-declared RIPE email.
  We cannot verify the email against RIPE without federation. Mitigations: the email is
  only shown to committed donors; API transfers fail loudly if the email is not a RIPE
  NCC Access account (RIPE returns 4xx); projects display the owner's display name and
  creation date; abuse is handled by closing projects (see the runbook).
- Donor keys: single request, never persisted, never logged. The function also refuses
  to proceed if the key would be echoed in any error path.

## API (managed functions, `/api/*`)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/me` | user | Profile + client principal. Creates the user row on first call. |
| `PUT /api/me` | user | Update `displayName`, `atlasEmail`, `affiliation`, `url`. |
| `DELETE /api/me` | user | Delete the profile, including the stored RIPE NCC Access email. |
| `GET /api/projects?status=open&tag=dns&q=` | public | List. `status` is `open`, `funded`, `closed`, `results` or `all`. Never includes emails. |
| `GET /api/projects/{id}` | public | Detail + public pledge feed (donor name, amount, status, message). |
| `POST /api/projects` | user (needs `atlasEmail`) | Create. 429 when the account posted less than a minute ago; 409 when the open-project cap closed this project again. |
| `PATCH /api/projects/{id}` | owner | Edit fields or set `status`. |
| `GET /api/projects/{id}/pledges` | owner or donor | Owner: all pledges. Donor: own. |
| `POST /api/projects/{id}/pledges` | user, not owner | `{amount, method, message, anonymous?, apiKey?}`. `anonymous` must be a real boolean when present; it withholds the donor's name from public views. Returns pledge and, for `manual`, the recipient email. |
| `PATCH /api/pledges/{projectId}/{id}` | donor or owner | Donor: `sent`/`cancelled`. Owner: `confirmed`/`cancelled` (for stale pledges). |
| `GET /api/my` | user | My projects + my pledges. |
| `GET /api/stats` | public | Totals for the home page. |
| `POST /api/atlas/balance` | user | `{apiKey}` → `{current_balance,...}` from RIPE. Never stored. |
| `GET /api/sitemap` | public | Sitemap XML of the public pages and every project not taken down. Served at `/sitemap.xml` by a rewrite in `staticwebapp.config.json`. |

Authorization is enforced twice: `staticwebapp.config.json` route rules require the
`authenticated` role on mutating routes, and every function re-checks the decoded
`x-ms-client-principal` header and ownership. Static Web Apps only supports a wildcard
at the end of a route, so `GET /api/projects/{id}/pledges` is protected in code only
(it returns a JSON 401). There is no global 401 redirect: API calls get JSON errors and
the SPA shows its own sign-in prompt.

## Azure resources (every one declared in Bicep)

| Resource | Bicep | SKU |
| --- | --- | --- |
| Resource group `internetresearch` (westus2) | `infra/main.bicep` | |
| Static Web App `swa-internetresearch` + `appsettings` (staging environments disabled) | `infra/app.bicep` | Free |
| Storage account `stinternetresearch<hash>` with tables `users`, `projects`, `pledges`, `claims` | `infra/app.bicep` | Standard LRS |
| Log Analytics `log-internetresearch` (0.1 GB/day cap, 30-day retention) + App Insights `appi-internetresearch` | `infra/platform.bicep` | Pay-as-you-go |
| Action group `ag-internetresearch`, five log search alerts, availability test `webtest-internetresearch-home` and its alert, workbook "Atlas Relay" | `infra/monitoring.bicep` | |
| User-assigned managed identity `id-internetresearch-ci` + federated credential for the GitHub `main` branch | `infra/identity.bicep` | |
| Custom role "Atlas Credit Exchange CI Deployer": read everything in the group; write deployments, the static site and storage only, minus site deletion/invitations/user roles/token reset and storage deletion/key regeneration | `infra/main.bicep` | |
| Role assignment of that role to the CI identity; `CanNotDelete` locks on the storage account and the static site | `infra/rbac.bicep` | |
| Public DNS zone `atlasrelay.org` with a `www` CNAME to the site and mail-rejection records | `infra/dns.bicep` | Azure DNS |

`main.bicep` is subscription-scoped and is run once by a subscription Owner via
`scripts/bootstrap.sh`. It creates the group, the CI identity, the custom role, the
monitoring resources, the role assignment and the locks, and deploys `app.bicep`.
`app.bicep` is what CI deploys on every infra change; it needs nothing beyond the custom
role, so a compromised workflow run cannot change RBAC, re-federate the identity, remove a
lock, delete the site or data, regenerate storage keys, or raise the log cap. It can still
read storage keys through `listKeys`, which the API itself needs, and it could change the
site's SKU.

`main.bicepparam` (bootstrap) and `app.bicepparam` (CI) both feed `app.bicep`;
`scripts/check-params.sh` fails lint if a shared value drifts, so neither path undoes
the other.

Why a managed identity rather than an Entra app registration: the Microsoft Graph Bicep
extension cannot be used from a personal Microsoft account, and the subscription is owned
by one. A user-assigned identity with federated identity credentials is a plain ARM
resource, works with `azure/login`, and needs no directory permissions.

Why the federated subject looks odd: the repository was created after 2026-07-15, so
GitHub issues immutable subjects of the form `repo:OWNER@OWNER-ID/REPO@REPO-ID:…`.
`bootstrap.sh` reads the prefix from the GitHub API and passes it to Bicep.

Why no pull-request previews: preview environments would run unreviewed code against the
production tables with a CI identity, so PRs only build, test and lint. Previews can be
re-enabled later by setting `enablePullRequestFederation` and
`stagingEnvironmentPolicy: Enabled`.

Upgrade path: SWA Standard for custom OIDC (RIPE NCC Access), an SLA and PR preview
environments.

## Repository layout

```
web/      Vite + React + TypeScript SPA; public/staticwebapp.config.json
api/      Azure Functions v4 (Node 22, TypeScript)
infra/    main.bicep (subscription scope) → identity.bicep, rbac.bicep, app.bicep (+ .bicepparam)
scripts/  bootstrap.sh (one-time provisioning + GitHub secret wiring) and its helpers; logs.sh
ops/queries/  saved KQL queries that scripts/logs.sh runs against the Log Analytics workspace
.github/workflows/deploy.yml   build + test on PRs; build + deploy app & API on main
.github/workflows/infra.yml    Bicep lint on PRs; what-if + deploy app.bicep on main (OIDC login)
docs/     this spec, RIPE research notes, runbook
```

## CI/CD

- `deploy.yml`, job `build` (no Azure identity): `npm ci -w api -w web`, tests, build
  web (with the repository variable `APPINSIGHTS_CONNECTION_STRING`, which turns on browser
  telemetry) and API, then stage a self-contained `api-deploy/` folder (npm workspaces hoist the
  API's runtime dependencies to the repo root, and the SWA action uploads the API folder
  verbatim), smoke-load the API entry point, upload both as artifacts. Runs on PRs too.
- `deploy.yml`, job `deploy` (push to `main` / manual only): download artifacts,
  `azure/login` (OIDC, managed identity), read the SWA deployment token with
  `az staticwebapp secrets list` (masked, never stored), then
  `Azure/static-web-apps-deploy@v1` with `skip_app_build`/`skip_api_build`.
- `deploy.yml`, job `indexnow` (after a deploy that uploaded, no Azure identity): runs
  `scripts/indexnow.mjs`, which reads the live `/sitemap.xml` and posts its URLs to IndexNow.
  It logs failures as warnings and is `continue-on-error`, so it cannot fail a deploy.
- `infra.yml`: lints every template and checks parameter drift on PRs; on `main` it
  logs in, runs `az deployment group what-if` (resource ids only, so no connection
  string reaches the log) then `create` on `infra/app.bicep`.
- Both workflows degrade to build/lint-only until bootstrap has run; after that
  (`AZURE_BOOTSTRAPPED` repo variable) a missing secret fails the run instead of
  skipping. Deployments to `main` are serialized (`concurrency`); PR runs have their own
  groups. Third-party actions are pinned to commit SHAs and kept current by Dependabot.
  The SWA deploy action is a Docker action that pulls `staticappsclient:stable`, so its
  SHA pins the wrapper, not the client image.
- The staged API artifact is built from the lockfile (`npm ci -w api --omit=dev`), so
  the tree that ships is the tree that was tested.
- `scripts/bootstrap.sh`: preflight checks, resource-provider registration, reads the
  GitHub OIDC subject prefix (validated against the repository's immutable-subject
  setting), runs `az deployment sub create` with
  `infra/main.bicep` (one retry for custom-role replication lag), waits for the role
  assignment, and stores the identity's client id, tenant id and subscription id as
  GitHub secrets plus the `AZURE_BOOTSTRAPPED` variable. Nothing else is created
  imperatively.

## Security notes

- Global headers: CSP (self, Google Fonts, and the App Insights ingestion endpoints for browser
  telemetry), HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`.
- Input validation on every write; string lengths, enums, URL scheme allow-list
  (`https:` only), integer ranges.
- Storage account: public blob access off, TLS 1.2 minimum, shared-key access used by
  the managed function via connection string (managed identity is not available on
  SWA managed functions; moving to a "bring your own Functions" app with identity is
  the upgrade path).
- Secrets: the storage connection string and the App Insights connection string, both
  written into the SWA app settings by Bicep (Bicep is the only writer; the settings
  resource replaces the whole map). GitHub holds three non-secret identifiers (client,
  tenant, subscription); the SWA deployment token is fetched per run and masked. Azure
  login from CI is OIDC. Untrusted build steps never run in a job that holds the identity.
