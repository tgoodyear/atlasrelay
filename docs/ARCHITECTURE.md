# Atlas Credit Exchange architecture

A small marketplace where RIPE Atlas users who need measurement credits post a
project, and users who have spare credits send them. The platform never holds
credits; RIPE Atlas remains the ledger. We hold the *ask*, the *pledge*, and the
*proof*.

## Goals and constraints

| Goal | Decision |
| --- | --- |
| Attractive, simple UI | Single-page React app, four core screens, no dashboards to learn. |
| Lowest cost, serverless | Azure Static Web Apps (Free) + managed Azure Functions + Azure Table Storage + App Insights inside its free allowance. Expected bill: under $1/month. A $120/month budget sends alerts; the subscription's spending limit (On) is the hard stop. |
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
   │                             tables: users, projects, pledges
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
| `createdAt`, `updatedAt` | |

### Pledge (`pledges` table, PK `<projectId>`, RK `<id>`)

| Field | Notes |
| --- | --- |
| `donorId`, `donorName` | |
| `amount` | Integer ≥ 1. Capped two ways: by the project's remaining *capacity* (100× the request, minus confirmed, minus live reservations) and by `maxSinglePledge`, which is what is left to the goal, or one goal's worth once the goal is met. The second cap stops any one pledge reserving the whole ceiling. |
| `method` | `api` (transfer executed by our function with the donor's key) or `manual` (donor transfers on atlas.ripe.net). |
| `status` | `pledged` → `sent` → `confirmed`; or `cancelled`. An `api` pledge goes straight to `confirmed` because our server observed RIPE accept the transfer, which is recorded in `transferredAt`. |
| `transactionId` | RIPE's transaction id, looked up after the transfer. The transfer endpoint itself returns only a generic list URL (`.../credits/transactions/?sort=-date&type=admin`), the same for every transfer and readable only with the donor's own key, so it is not a reference. The lookup needs the credits-read permission and is best effort. |
| `transactionUrl` | The URL RIPE returned, when method is `api`. |
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
     checked before sending. A transfer-only key works, with the check skipped. The
     function optionally reads the balance (`GET /credits/`) to warn on insufficient
     funds. The pledge row is written **before** the transfer, then the function calls
     `POST /credits/transfers/` exactly once. On 201 the pledge becomes `confirmed`
     and the transaction is looked up to record a real id. The key lives only in the
     request scope. The UI tells donors to delete or disable the key afterwards.
   - **I'll transfer on atlas.ripe.net**: we show the recipient email and amount with
     a link to https://atlas.ripe.net/credits/transfer/. The pledge is `pledged`; the
     donor marks it `sent`; the requester marks it `confirmed`.
3. Donor's pledges are listed on their dashboard.

### Ordering, and what happens when a transfer fails

Table Storage has no transaction that can span a local write and a call to RIPE, so the order of
the two decides which way a failure hurts. The pledge row is written first. An orphan row is a
pledge somebody cancels; a transfer with no row is credits nobody can account for.

What happens next depends on a single question: did RIPE answer?

| Outcome | What we know | What the platform does |
| --- | --- | --- |
| 201 | The credits moved | Pledge becomes `confirmed`; the transaction id is looked up and stored |
| 4xx or 429 from RIPE | RIPE refused, nothing moved | Pledge is cancelled, the donor sees why and can try again |
| Timeout or network failure | Unknown | Pledge is parked at `sent` and flagged uncertain |

An uncertain pledge takes the same path a manual one does: it sits on both dashboards until the
requester confirms the credits arrived or the donor cancels it. Both parties see "Sent, outcome
unknown" rather than a badge claiming a transfer we never saw succeed. The donor is sent to
https://atlas.ripe.net/credits/transactions/ to check before sending anything again, and the
dialog gives them no way to resubmit.

Once the credits have moved, nothing in the handler is allowed to fail the request: the
transaction lookup and the row update are both best-effort, because a retry at that point would
send the credits twice.

### Abuse limits

- A donor may hold one live pledge per project. Without it, one account could reserve a project
  repeatedly and re-read the owner's contact address at will.
- No single pledge may reserve a project's whole ceiling, so one free account cannot block every
  other donor.
- Reservations expire after 14 days, so the site heals without a background job.
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

### Trust model
- Requester identity is a GitHub/Microsoft account plus a self-declared RIPE email.
  We cannot verify the email against RIPE without federation. Mitigations: the email is
  only shown to committed donors; API transfers fail loudly if the email is not a RIPE
  NCC Access account (RIPE returns 4xx); projects display owner handle and creation
  date; abuse can be handled by closing projects (admin role is a later addition).
- Donor keys: single request, never persisted, never logged. The function also refuses
  to proceed if the key would be echoed in any error path.

## API (managed functions, `/api/*`)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/me` | user | Profile + client principal. Creates the user row on first call. |
| `PUT /api/me` | user | Update `displayName`, `atlasEmail`, `affiliation`, `url`. |
| `DELETE /api/me` | user | Delete the profile, including the stored RIPE NCC Access email. |
| `GET /api/projects?status=open&tag=dns&q=` | public | List. Never includes emails. |
| `GET /api/projects/{id}` | public | Detail + public pledge feed (donor name, amount, status, message). |
| `POST /api/projects` | user (needs `atlasEmail`) | Create. |
| `PATCH /api/projects/{id}` | owner | Edit fields or set `status`. |
| `GET /api/projects/{id}/pledges` | owner or donor | Owner: all pledges. Donor: own. |
| `POST /api/projects/{id}/pledges` | user, not owner | `{amount, method, message, apiKey?}`. Returns pledge and, for `manual`, the recipient email. |
| `PATCH /api/pledges/{projectId}/{id}` | donor or owner | Donor: `sent`/`cancelled`. Owner: `confirmed`/`cancelled` (for stale pledges). |
| `GET /api/my` | user | My projects + my pledges. |
| `GET /api/stats` | public | Totals for the home page. |
| `POST /api/atlas/balance` | user | `{apiKey}` → `{current_balance,...}` from RIPE. Never stored. |

Authorization is enforced twice: `staticwebapp.config.json` route rules require the
`authenticated` role on mutating routes, and every function re-checks the decoded
`x-ms-client-principal` header and ownership. Static Web Apps only supports a wildcard
at the end of a route, so `GET /api/projects/{id}/pledges` is protected in code only
(it returns a JSON 401). There is no global 401 redirect: API calls get JSON errors and
the SPA shows its own sign-in prompt.

## Azure resources (every one declared in Bicep)

| Resource | Bicep | SKU | Est. cost |
| --- | --- | --- | --- |
| Resource group `internetresearch` (westus2) | `infra/main.bicep` | | $0 |
| Static Web App `swa-internetresearch` + `appsettings` | `infra/app.bicep` | Free | $0 (100 GB bandwidth/mo, 2 custom domains; staging environments disabled) |
| Storage account `stinternetresearch<hash>` with tables `users`, `projects`, `pledges` | `infra/app.bicep` | Standard LRS | ≈ $0.05/mo at expected volumes |
| Log Analytics `log-internetresearch` (0.1 GB/day cap, 30-day retention) + App Insights `appi-internetresearch` | `infra/platform.bicep` | Pay-as-you-go | $0 inside the 5 GB/month free allowance |
| Consumption budget `internetresearch-monthly` | `infra/platform.bicep` | $120, alerts at 50% and 80% actual, 100% forecast | $0 |
| User-assigned managed identity `id-internetresearch-ci` + federated credential for the GitHub `main` branch | `infra/identity.bicep` | | $0 |
| Custom role "Atlas Credit Exchange CI Deployer": read everything in the group; write deployments, the static site and storage only, minus site deletion/invitations/user roles/token reset and storage deletion/key regeneration | `infra/main.bicep` | | $0 |
| Role assignment of that role to the CI identity; `CanNotDelete` locks on the storage account and the static site | `infra/rbac.bicep` | | $0 |
| Public DNS zone `atlasrelay.org` with a `www` CNAME to the site and mail-rejection records | `infra/dns.bicep` | Azure DNS | ≈ $0.50/mo plus query charges |

`main.bicep` is subscription-scoped and is run once by a subscription Owner via
`scripts/bootstrap.sh`. It creates the group, the CI identity, the custom role, the
monitoring and budget resources, the role assignment and the locks, and deploys
`app.bicep`. `app.bicep` is what CI deploys on every infra change; it needs nothing
beyond the custom role, so a compromised workflow run cannot change RBAC, re-federate the
identity, remove a lock, delete the site or data, regenerate storage keys, raise the log
cap, or silence the budget. (It can still read storage keys through `listKeys`, which the
API itself needs, and it could move the site to the Standard SKU, about $9/month.)

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

Upgrade path that stays well inside budget: SWA Standard ($9/mo) for custom OIDC
(RIPE NCC Access), an SLA and PR preview environments.

## Repository layout

```
web/      Vite + React + TypeScript SPA; public/staticwebapp.config.json
api/      Azure Functions v4 (Node 22, TypeScript)
infra/    main.bicep (subscription scope) → identity.bicep, rbac.bicep, app.bicep (+ .bicepparam)
scripts/  bootstrap.sh (one-time provisioning + GitHub secret wiring), budget-start-date.sh
.github/workflows/deploy.yml   build + test on PRs; build + deploy app & API on main
.github/workflows/infra.yml    Bicep lint on PRs; what-if + deploy app.bicep on main (OIDC login)
docs/     this spec, RIPE research notes, runbook
```

## CI/CD

- `deploy.yml`, job `build` (no Azure identity): `npm ci -w api -w web`, tests, build
  web and API, then stage a self-contained `api-deploy/` folder (npm workspaces hoist the
  API's runtime dependencies to the repo root, and the SWA action uploads the API folder
  verbatim), smoke-load the API entry point, upload both as artifacts. Runs on PRs too.
- `deploy.yml`, job `deploy` (push to `main` / manual only): download artifacts,
  `azure/login` (OIDC, managed identity), read the SWA deployment token with
  `az staticwebapp secrets list` (masked, never stored), then
  `Azure/static-web-apps-deploy@v1` with `skip_app_build`/`skip_api_build`.
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
  setting) and the budget start date, runs `az deployment sub create` with
  `infra/main.bicep` (one retry for custom-role replication lag), waits for the role
  assignment, and stores the identity's client id, tenant id and subscription id as
  GitHub secrets plus the `AZURE_BOOTSTRAPPED` variable. Nothing else is created
  imperatively.

## Security notes

- Global headers: CSP (self + Google Fonts), HSTS, `X-Content-Type-Options`,
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
