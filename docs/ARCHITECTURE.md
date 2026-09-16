# Atlas Credit Exchange – architecture

A small marketplace where RIPE Atlas users who need measurement credits post a
project, and users who have spare credits send them. The platform never holds
credits; RIPE Atlas remains the ledger. We hold the *ask*, the *pledge*, and the
*proof*.

## Goals and constraints

| Goal | Decision |
| --- | --- |
| Attractive, simple UI | Single-page React app, four core screens, no dashboards to learn. |
| Lowest cost, serverless | Azure Static Web Apps (Free) + managed Azure Functions + Azure Table Storage. Expected bill: under $1/month. Budget cap $120/month enforced with an Azure budget alert. |
| CI/CD from GitHub | Two GitHub Actions workflows: app deploy (push to `main`, PR previews) and infra (Bicep via OIDC federated credential, no stored Azure secrets). |
| Identity | GitHub or Microsoft sign-in via Static Web Apps built-in auth. RIPE NCC Access OIDC is not obtainable for third parties today (see `RIPE-ATLAS-NOTES.md`); the design leaves a slot for it. |
| Never custody credits or keys | Transfers happen on RIPE's side. API keys supplied by donors are used for one request and discarded; nothing key-like is written to storage or logs. |

## System diagram

```
 Browser (React SPA)
   │  /.auth/login/github | /.auth/login/aad      (SWA built-in auth, free)
   │  /api/*  (x-ms-client-principal injected by SWA edge)
   ▼
 Azure Static Web Apps (Free)  ── managed Azure Functions (Node 20, HTTP only)
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
| `status` | `open` \| `closed`. `funded` is derived (`creditsConfirmed >= creditsRequested`). |
| `tags` | Subset of: ping, traceroute, dns, sslcert, http, ntp, ipv4, ipv6, anchors, other. |
| `affiliation`, `homepageUrl`, `repoUrl`, `paperUrl`, `deadline` | Optional. |
| `createdAt`, `updatedAt` | |

### Pledge (`pledges` table, PK `<projectId>`, RK `<id>`)

| Field | Notes |
| --- | --- |
| `donorId`, `donorName` | |
| `amount` | Integer ≥ 1, capped at the project's remaining need at pledge time. |
| `method` | `api` (transfer executed by our function with the donor's key) or `manual` (donor transfers on atlas.ripe.net). |
| `status` | `pledged` → `sent` → `confirmed`; or `cancelled`. `api` pledges go straight to `confirmed` with `transactionUrl` proof because our server observed RIPE's 201. |
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
1. Open a project, click **Send credits**, pick an amount (defaults to what's left).
2. Choose one:
   - **Transfer now with an API key** – donor pastes a key created at
     https://atlas.ripe.net/keys/ with only the credit-transfer permission. The
     function optionally reads the balance (`GET /credits/`) to warn on insufficient
     funds, then calls `POST /credits/transfers/`. On 201 the pledge is stored as
     `confirmed` with the transaction URL. The key lives only in the request scope.
     The UI tells donors to delete or disable the key afterwards.
   - **I'll transfer on atlas.ripe.net** – we show the recipient email and amount with
     a link to https://atlas.ripe.net/credits/transfer/. The pledge is `pledged`; the
     donor marks it `sent`; the requester marks it `confirmed`.
3. Donor's pledges are listed on their dashboard.

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

## Azure resources (all in resource group `internetresearch`)

| Resource | SKU | Est. cost |
| --- | --- | --- |
| Static Web App `swa-internetresearch` | Free | $0 (100 GB bandwidth/mo, 2 custom domains, 3 staging envs) |
| Storage account `stinternetresearch<hash>` | Standard LRS, tables only | ≈ $0.05/mo at expected volumes |
| Consumption budget `internetresearch-monthly` | $120 cap, alerts at 50/80/100% | $0 |

Upgrade paths that stay well inside budget: SWA Standard ($9/mo) for custom OIDC
(RIPE NCC Access) and SLA; Application Insights (first 5 GB/mo free) for API logs.

## Repository layout

```
web/      Vite + React + TypeScript SPA; public/staticwebapp.config.json
api/      Azure Functions v4 (Node 20, TypeScript)
infra/    main.bicep (+ parameters), resource-group scope
scripts/  bootstrap.sh – one-time provisioning + GitHub secret wiring
.github/workflows/deploy.yml   build + deploy app & API on push/PR
.github/workflows/infra.yml    Bicep what-if on PR, deploy on main (OIDC login)
docs/     this spec, RIPE research notes, runbook
```

## CI/CD

- `deploy.yml`: `npm ci && npm run build` for `web` and `api`, prune dev deps, then
  `Azure/static-web-apps-deploy@v1` with `skip_app_build`/`skip_api_build`. Uses the
  SWA deployment token secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. PRs get preview URLs.
- `infra.yml`: `azure/login@v2` with a federated credential (no client secret), then
  `az deployment group what-if` on PRs and `create` on `main`.
- `scripts/bootstrap.sh`: creates the resource group, runs the Bicep deployment,
  creates the Entra app + federated credential scoped to `repo:tgoodyear/internetresearch:ref:refs/heads/main`,
  assigns Contributor on the resource group, and pushes all GitHub secrets.

## Security notes

- Global headers: CSP (self + Google Fonts), `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS is provided by the platform.
- Input validation on every write; string lengths, enums, URL scheme allow-list
  (`https:` only), integer ranges.
- Storage account: public blob access off, TLS 1.2 minimum, shared-key access used by
  the managed function via connection string (managed identity is not available on
  SWA managed functions; moving to a "bring your own Functions" app with identity is
  the upgrade path).
- Secrets: only the storage connection string (SWA app setting) and the SWA deploy
  token (GitHub secret). Azure login from CI is OIDC.
