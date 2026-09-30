# Runbook

## Environments

Everything in Azure is one deployment stack per environment, `atlasrelay-<env>`, at subscription
scope, declared in `infra/main.bicep`. `prod` serves atlasrelay.org. `dev` is optional and is
deployed from the same template. Environment names are 1 to 6 lowercase letters and digits, starting with a letter.

| Resource | prod | Declared in |
| --- | --- | --- |
| Resource group | `rg-atlasrelay-prod` | `infra/main.bicep` |
| Static Web App (Standard) | `swa-atlasrelay-prod` | `infra/app.bicep` |
| Storage account with tables `users`, `projects`, `pledges`, `claims` | `statlasrelayprod<6 characters>` | `infra/app.bicep` |
| Function App (Flex Consumption), linked to the site as its API, with its app settings and plan | `func-atlasrelay-prod-<6 characters>`, `plan-atlasrelay-prod-api` | `infra/api.bicep` |
| The Function App's managed identity | `id-atlasrelay-prod-api` | `infra/api.bicep` |
| Storage account for the Functions host and the deployment package | `stfnatlasrelayprod<4 characters>` | `infra/api.bicep` |
| Log Analytics workspace | `log-atlasrelay-prod` | `infra/platform.bicep` |
| Application Insights | `appi-atlasrelay-prod` | `infra/platform.bicep` |
| Action group, log search alerts `alert-atlasrelay-prod-*`, availability test `webtest-atlasrelay-prod-home`, workbook "Atlas Relay" | `ag-atlasrelay-prod` | `infra/monitoring.bicep` |
| CI identity, federated with the GitHub Environment `prod` | `id-atlasrelay-prod-ci` | `infra/identity.bicep` |
| Custom roles and their assignments to the CI identity | "Atlas Relay CI Deployer (prod)", "Atlas Relay CI API Deployer (prod)" | `infra/rbac.bicep` |
| Public DNS zone (prod only) | `atlasrelay.org` | `infra/dns.bicep` |

Every resource is tagged `project=atlasrelay` and `environment=<env>`. `dev` gets the same set
with `dev` in the names, no zone, and a `dev` CNAME in the prod zone (`infra/dns-subdomain.bicep`).
It also gets the full-flow test harness, which is never deployed in prod
([Full-flow tests on dev](#full-flow-tests-on-dev)):

| Resource (dev only) | dev | Declared in |
| --- | --- | --- |
| Virtual network with subnets `snet-cae` and `snet-pe`, private DNS zone `privatelink.vaultcore.azure.net` | `vnet-atlasrelay-dev` | `infra/testharness.bicep` |
| Key Vault for the test accounts, no public network access, with a private endpoint | `kv-atlasrelay-dev-<3 characters>`, `pe-atlasrelay-dev-kv` | `infra/testharness.bicep` |
| Test identity: reads the vault's secrets, writes the results | `id-atlasrelay-dev-e2e` | `infra/testharness.bicep` |
| Storage account for test results, container `results`, Entra ID only | `stare2edev<6 characters>` | `infra/testharness.bicep` |
| Container Apps environment in `snet-cae`, and the test job | `cae-atlasrelay-dev`, `caj-atlasrelay-dev-e2e` | `infra/testharness.bicep` |
| Custom role for the CI identity, and its read access to the results | "Atlas Relay e2e runner (dev)" | `infra/testharness-rbac.bicep` |

`scripts/bootstrap.sh` and `scripts/provision.sh` deploy the stack with
`--action-on-unmanage deleteResources` and `--deny-settings-mode denyDelete`:

- A resource removed from the templates, or switched off by a setting, is deleted on the next
  deployment. Resource groups are the exception; `scripts/teardown.sh` removes them.
- Nothing the stack manages can be deleted outside it, by anyone, Owners included. Writes are
  allowed, so the portal and `az` can still change settings, and bindings and records the stack
  does not declare can still be removed. To delete a managed resource by hand, first deploy with
  `DENY_SETTINGS_MODE=none scripts/provision.sh <env>`; the next ordinary deployment restores
  the deny assignments.
- Deployment stacks have no what-if.

CI deploys no Bicep. The CI roles can read the resource group, the static web app and its linked
backend, list the site's deployment token, and read the Function App and publish a package to it.
They grant nothing else. In dev, CI can also start the test job and read its results and logs.
Every infrastructure change is a stack deployment by a subscription Owner.

No storage account accepts shared keys. The API signs in to storage with its managed identity, and
the operator named in the setting `ATLASRELAY_OPERATOR_PRINCIPAL_ID` (whoever ran
`scripts/bootstrap.sh`) gets Storage Table Data Contributor on the data account for the commands
under [Operations](#operations). See "Storage access" in [ARCHITECTURE.md](ARCHITECTURE.md#storage-access).

### Settings

An environment's settings are `KEY="value"` lines in `.azure/<env>/.env`, which is git-ignored.
`.azure/env.example` lists them. `infra/main.bicepparam` reads them with
`readEnvironmentVariable`, and the stack's outputs (`SWA_NAME`, `CI_CLIENT_ID`, `NAME_SERVERS`
and the rest) are written back after each deployment.

```bash
scripts/settings.sh prod                          # show all
scripts/settings.sh prod SWA_HOSTNAME             # one
scripts/settings.sh prod ATLASRELAY_DNS_TTL 300   # change one
scripts/provision.sh prod                         # deploy the stack with the new settings
```

The settings file holds two values the repository does not: the apex validation token and the
subscription the environment lives in. Keep it; `scripts/teardown.sh` renames it rather than
deleting it.

## First deployment

Prerequisites: `az` 2.61 or later, signed in as an Owner of the subscription
(`az login --tenant <tenant-id>` if the tenant enforces MFA); `gh`, signed in as an admin of the
repository; `jq`, `dig` and Node 22.12+.

```bash
scripts/bootstrap.sh prod --subscription <id> --alert-email you@example.org --domain atlasrelay.org
```

It is idempotent. It:

1. Registers the resource providers the templates use.
2. Reads the repository's GitHub OIDC subject prefix and writes the settings.
3. Deploys the stack `atlasrelay-prod`, retrying twice if a new custom role has not replicated
   yet, and saves its outputs as settings. The Function App is linked to the site in the same
   deployment.
4. Creates the GitHub Environment `prod` and restricts it to the `main` branch. The CI identity
   trusts only jobs in that GitHub Environment.
5. Sets the repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`
   (identifiers, not credentials) and the variables `AZURE_BOOTSTRAPPED` and
   `APPINSIGHTS_CONNECTION_STRING` (read by the Deploy workflow for browser telemetry).

Then deploy the site with `gh workflow run deploy.yml --ref main`, or merge to `main`. Role
assignments can take a few minutes to propagate; if that first run fails with
`AuthorizationFailed` or a 403 from the publish step, re-run it.

## Local development

```bash
npm install            # installs the web and api workspaces and local tooling
npm run dev            # Azurite + Functions host (:7071) + Vite (:5173) + SWA emulator (:4280)
```

`npm run dev` copies `api/local.settings.json.example` to `api/local.settings.json` if it
is missing; that file points `TABLES_CONNECTION_STRING` at Azurite. Only local runs and tests use
a connection string; in Azure the API has `TABLES_ENDPOINT` and a managed identity instead. Open
http://localhost:4280. The SWA emulator lets you "log in" as any username without a real
GitHub account. Node 22.12 or newer is required; newer major versions work with a warning
from the Functions host. `func` comes from Azure Functions Core Tools v4, installed
separately (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Custom domain (atlasrelay.org)

The public DNS zone is Azure DNS, declared in `infra/dns.bicep` and part of the prod stack. The
stack is the only writer of the zone.

1. At the registrar (Squarespace Domains), set the name servers to the four in
   `scripts/settings.sh prod NAME_SERVERS`.
2. Wait for the delegation to appear in public DNS: `dig +short NS atlasrelay.org @1.1.1.1`.
3. Bind the domain: `scripts/bind-custom-domain.sh prod`. It binds `www` by CNAME delegation and
   the apex by TXT token, saves the apex token as the setting `ATLASRELAY_SWA_APEX_TOKEN`, and
   redeploys the stack so the token is published at the apex.
4. Once both hostnames are `Ready`, make the apex the default domain (see
   [Canonical host](#canonical-host)).

A static web app can hold a hostname only if no other static web app in the same slice holds it.
The slice is the number in the site's default hostname, `<name>.<slice>.azurestaticapps.net`.

### A hostname stuck at "Validating"

A hostname bound with the wrong validation method never recovers on its own, and the method
cannot be changed in place. `az staticwebapp hostname set` with a different `--validation-method`
returns 200 and changes nothing; the binding keeps its original method and its original token.

Check which method a hostname is using:

```bash
az staticwebapp hostname list -n swa-atlasrelay-prod -g rg-atlasrelay-prod --subscription <id> -o table
```

A populated `ValidationToken` means TXT-token validation. That works for the apex, whose token is
a TXT record on `@`, but not for `www` as this zone is set up, because a TXT record at `www` would
sit beside the CNAME, and DNS forbids a CNAME alongside any other record at the same name. So
`www` uses `cname-delegation`, which validates against the CNAME that is already there.

The only fix is to recreate the binding. Bindings are not managed by the stack, so the stack's
deny assignment does not stop this:

```bash
az staticwebapp hostname delete -n swa-atlasrelay-prod -g rg-atlasrelay-prod --subscription <id> \
  --hostname www.atlasrelay.org --yes
az staticwebapp hostname set -n swa-atlasrelay-prod -g rg-atlasrelay-prod --subscription <id> \
  --hostname www.atlasrelay.org --validation-method cname-delegation
```

The apex binding is untouched throughout. With the CNAME already published, the new binding
reaches `Ready` immediately and the certificate is served within a minute.

### Apex routing

DNS forbids a CNAME at the apex and an Azure DNS alias record cannot target a static site, so
`infra/dns.bicep` declares an A record built from the site's `stableInboundIP`. The apex TXT
token only validates the hostname; it does not route it, and Static Web Apps creates no record
of its own. If the apex stops resolving, check this A record first. The binding script refuses
to run unless all four name servers are delegated, and fails if a binding is rejected.

The zone also publishes a `www` CNAME to the site, the Google Search Console verification token
(`dnsApexTxtValues` in `infra/main.bicepparam`), and records stating the domain sends no mail
(RFC 7505 null MX, `v=spf1 -all`, DMARC `p=reject`). Set `rejectMail` to false in
`infra/dns.bicep` if the domain ever needs to send email.

### Canonical host

`https://atlasrelay.org` is the canonical host. The canonical tags, the sitemap and the
IndexNow submission all use it, and the README links it. The apex resolves through the A record
described above, while `www` is a CNAME to the site's own hostname. Both stay bound to the site.

`www.atlasrelay.org` serves the same pages until the apex is made the site's default domain.
Static Web Apps then answers every other hostname of the site, `www` and the
`azurestaticapps.net` name included, with a redirect to it. This is a one-time step for a
subscription Owner, in the portal: open `swa-atlasrelay-prod`, then **Custom domains**, select
`atlasrelay.org`, and choose **Set default**. The custom domain schema has no default-domain
property, so Bicep cannot declare it, and the CI role cannot write custom domains. Check it
afterwards:

```bash
curl -sI 'https://www.atlasrelay.org/projects?status=all' | grep -iE '^(HTTP|location)'
# expect a permanent redirect to https://atlasrelay.org/projects?status=all
```

## Dev environment

`dev` is the same template with `environmentName = dev`. Nothing deploys it automatically:

```bash
scripts/bootstrap.sh dev --domain atlasrelay.org
scripts/bind-custom-domain.sh dev      # once dev.atlasrelay.org resolves
```

The stack `atlasrelay-dev` holds `rg-atlasrelay-dev` and everything in it, and the `dev` CNAME
in the prod zone, pointing at `swa-atlasrelay-dev`. The CNAME and the site are in one stack, so a
rebuilt site takes its record with it. The Deploy workflow deploys prod only. To put a build on
dev, build it, publish the API to dev's Function App, then upload the site with the dev site's
token:

```bash
npm ci && npm run build
rm -rf api-deploy api.zip && mkdir -p api-deploy/dist
cp api/dist/bundle.js api-deploy/dist/ && cp api/host.json api/package.json api-deploy/
(cd api-deploy && zip -qr ../api.zip .)
az functionapp deployment source config-zip -g rg-atlasrelay-dev --subscription <id> \
  -n "$(scripts/settings.sh dev FUNCTION_APP_NAME)" --src api.zip
TOKEN=$(az staticwebapp secrets list -n swa-atlasrelay-dev -g rg-atlasrelay-dev \
  --subscription <id> --query properties.apiKey -o tsv)
npx swa deploy web/dist --deployment-token "$TOKEN" --env production
```

`scripts/teardown.sh dev` removes it again, the CNAME and the test harness included.

## Testing a deployed site

Pull requests run the full-flow tests (`web/e2e/flows`, see [CONTRIBUTING.md](../CONTRIBUTING.md))
against a copy of the whole application on the CI runner, with the emulator's sign-in and a stub
in place of the RIPE Atlas API. A deployed site gets three more checks: the smoke test, the
full-flow tests on dev with real Microsoft sign-in, and a short list of manual checks.

### Smoke test

`web/e2e/smoke/smoke.spec.ts` reads a live site without signing in or writing anything: each page
and its head, the 404 pages, `robots.txt`, the sitemap and a project page from it, the security
headers, the public API, and that the private API routes answer 401. It sends only GET and HEAD
requests, and it blocks the browser's App Insights requests so a run is not counted as traffic.
It is safe against prod:

```bash
npx -w web playwright install chromium   # once
BASE_URL=https://atlasrelay.org npm run test:smoke -w web
```

The same file runs against the local stack in every full-flow run.

### Full-flow tests on dev

`e2e-real/` signs two test accounts into https://dev.atlasrelay.org through the real Microsoft
sign-in page and runs the flow there, with the page steps the local full-flow tests use
(`web/e2e/ui.ts`): the researcher saves a profile and posts a project, the donor pledges to
transfer by hand and marks the credits sent, the researcher confirms them and posts results, and a
signed-out visitor sees the funded project without the researcher's email. No credits move. The
tests delete both profiles before and after each run; the site cannot delete a project, so each
run leaves one closed project shown as Anonymous.

The tests run in Azure. `.github/workflows/e2e-dev.yml`:

1. builds the test image from `e2e-real/Dockerfile` and pushes it to
   `ghcr.io/tgoodyear/atlasrelay-e2e`, tagged with the commit;
2. in the GitHub Environment `dev`, signs in to Azure as the dev CI identity (OIDC) and starts the
   Container Apps job `caj-atlasrelay-dev-e2e` with that image, pinned by digest;
3. waits for the execution (the job gives a run 20 minutes, and never retries);
4. downloads the results from the storage account's `results` container, uploads them as the
   run's artifact, and fails the run unless every test passed.

Inside the job, `e2e-real/run.mjs` reads the accounts from the Key Vault
`kv-atlasrelay-dev-<3 characters>` as the job's identity, through the vault's private endpoint,
signs both accounts in once (`e2e-real/global-setup.ts`, outside any trace or report), runs the
suite, and replaces the passwords and the site's session cookies with `[redacted]` in the output
and in every result file, trace archives included, before uploading. GitHub never holds the
passwords, and the CI identity has no role on the vault.

#### Setting it up

Once per dev environment, as the Owner:

1. Bootstrap dev and put a build on it ([Dev environment](#dev-environment)). For `dev`,
   `scripts/bootstrap.sh` also deploys the harness, gives you write access to the vault's secrets
   (the setting `ATLASRELAY_OPERATOR_PRINCIPAL_ID`), makes the GitHub Environment `dev` wait for your
   approval, stores the identifiers the workflow reads as variables of that environment, and sets
   the repository variable `DEV_ENABLED=true`.
2. Create the test tenant and its two users:
   - At https://entra.microsoft.com, **Manage tenants**, **Create**, a Microsoft Entra ID
     tenant. It needs no subscription and holds nothing but the two users.
   - In the new tenant, **Overview**, **Properties**, **Manage security defaults**: off, so the
     users are not asked to register for MFA.
   - **Users**, **New user**: a researcher and a donor, for example
     `researcher@<tenant>.onmicrosoft.com` and `donor@<tenant>.onmicrosoft.com`, each with a long
     random password.
   - Sign in once with each at https://dev.atlasrelay.org/login/microsoft in a private window.
     Microsoft may ask for a new password (set one, and use that below) and whether the site may
     read the profile (accept).
3. Store the accounts in the vault:

   ```bash
   scripts/set-test-users.sh dev
   ```

   It asks for the two usernames and passwords (the passwords without echo), or takes them from
   `E2E_RESEARCHER_USERNAME`, `E2E_RESEARCHER_PASSWORD`, `E2E_DONOR_USERNAME` and
   `E2E_DONOR_PASSWORD`. The vault normally refuses every connection from outside its network.
   The script adds a rule for this machine's public IPv4 address (`--ip` to give it), turns public
   access on with every other address denied, writes the four secrets through Key Vault's REST
   API, then removes the rule and turns public access off, even if a step failed or you pressed
   Ctrl-C. If closing fails, it prints a warning; `scripts/provision.sh dev` closes the vault too,
   since the template declares public access off. Run it again to change a
   password.
4. Run the workflow once (below). The first run pushes the image as a private package, and the
   run job stops with "cannot be pulled anonymously". Make the package public: on GitHub, your
   profile, **Packages**, `atlasrelay-e2e`, **Package settings**, **Change visibility**,
   **Public**. It holds only the test code in this repository. Then re-run the failed job.

#### Running it

The workflow runs after every push to `main` that changes `web/`, `api/`, `infra/`, `e2e-real/`
or the workflow, and by hand:

```bash
gh workflow run e2e-dev.yml --ref main
```

Only the owner can make it run:

- It has no pull request trigger of any kind, so neither a pull request nor a fork can start it.
  Only the owner can merge to `main` (the "Protect main" ruleset).
- Every job runs only when the repository is `tgoodyear/atlasrelay`, the actor is `tgoodyear` and
  the ref is `main`.
- The job that gets an Azure token runs in the GitHub Environment `dev`, which only `main` may use
  and which waits for the owner's approval, with no bypass for administrators. On the run's page,
  **Review deployments**, tick `dev`, **Approve and deploy**. The dev CI identity trusts only jobs
  in that environment (its federated credential's subject ends in `:environment:dev`).
- While dev does not exist (`DEV_ENABLED` is not `true`), the workflow prints a notice and does
  nothing else.

To let runs start without the approval, run `scripts/bootstrap.sh dev --no-approval`. Removing the
reviewer in the repository's **Settings**, **Environments**, `dev` works too, but the next
`scripts/bootstrap.sh dev` without `--no-approval` puts it back.

#### Reading the results

The run's summary page lists each test and its outcome. The artifact `e2e-dev-gh-<run id>-<attempt>`
holds:

- `summary.json`: the outcome, the counts, each test with its error, the image and commit, and
  which files were redacted;
- `report.json`: the Playwright report;
- `console.txt`: the suite's output;
- `test-results/`: for a failed test, screenshots, `error-context.md` (the page as the test saw
  it) and `trace.zip` (open it with `npx playwright show-trace trace.zip`);
- `job-logs.tsv`, when the execution did not succeed: the job's console and system logs from Log
  Analytics, which covers a container that never started. The logs take a few minutes to arrive;
  re-run the job if the file is empty.

The same files stay in the `results` container, under `runs/<run id>/`, for 30 days.

Microsoft sign-in errors name the page they stopped on: "register for MFA" means security defaults
are on in the test tenant; "change its password" means the password expired or was reset, so sign
in by hand, set a new one and run `scripts/set-test-users.sh dev` again.

#### Accounts with MFA

If the test tenant has to require MFA, give each account an authenticator app with a TOTP seed
(**Security info**, **Add sign-in method**, **Authenticator app**, **I want to use a different
authenticator app**, **Can't scan image?** shows the secret key) and store the seed with the
account:

```bash
E2E_RESEARCHER_TOTP=<secret key> E2E_DONOR_TOTP=<secret key> scripts/set-test-users.sh dev
```

The sign-in then answers the code prompt with a code computed from the seed (`e2e-real/lib/totp.mjs`).
Pass the seeds through a prompt of your own (`read -rs`) rather than typing them into the command
line, so they stay out of the shell history.

#### A real RIPE Atlas transfer (not enabled)

`e2e-real/specs/ripe-transfer.spec.ts` is a skipped placeholder. The comment in it describes the
test: a RIPE Atlas API key with only the transfer permission, stored in the same vault as
`e2e-donor-ripe-transfer-key`, and a one-credit API pledge to a second real RIPE Atlas account.
Until then, API transfers are a manual check.

#### Removing it

`scripts/teardown.sh dev` removes the harness with the rest of dev: the network, the vault (purged
after it is deleted, so the same name can be used again at once), the job, the environment and the
results. It deletes the repository variable `DEV_ENABLED` first and the GitHub Environment `dev`
with its variables. The test tenant and the GHCR package are outside Azure and stay; delete them by
hand if dev will not come back.

### Manual checks

Real transfers never run in CI, and GitHub sign-in is not automated. Check them by hand on a dev
environment (`scripts/bootstrap.sh dev`, then upload the build to test as described under
[Dev environment](#dev-environment)), not on prod: they create projects, pledges and profiles, and
a transfer moves real credits. Use two browsers, or one normal and one private window, for the
researcher and the donor. Microsoft sign-in, the profile, a manual pledge, confirming it and
posting results are covered by the full-flow tests on dev.

1. **GitHub sign-in.** Click **Sign in**, sign in with a real GitHub account, and expect
   `/dashboard` with your username in the header. **Sign out** returns to the home page, signed out.
2. **Microsoft username.** Microsoft sends an email address as the username. Sign in with
   **Continue with Microsoft**, post a project without changing the display name, and check that
   the byline shows only the part before the `@`.
3. **Profile.** Save a display name and the RIPE NCC Access email of a real atlas.ripe.net
   account. That account is the researcher.
4. **API transfer.** As the researcher, post a project asking for 1,000 credits. As the donor,
   signed in with another account, create a key at https://atlas.ripe.net/keys/ with only
   "Transfer credits to another user" and "Get information about your credits", valid for a day.
   Pledge 100 credits with it. Expect **Check balance** to show the donor's balance, then
   **Credits transferred** and a pledge marked **Transferred via API**. A minute or two later both
   accounts' logs at https://atlas.ripe.net/credits/transactions/ show the 100 credits. Delete
   the key.
5. **Manual transfer.** Pledge 100 more by hand, transfer the credits on
   https://atlas.ripe.net/credits/transfer/ to the email the dialog shows, and check both accounts'
   transaction logs.
6. **Clean up.** Delete both profiles on `/profile`, or remove the environment with
   `scripts/teardown.sh dev`.

## Changing infrastructure

Edit `infra/*.bicep` or `infra/main.bicepparam` and open a pull request. The Infrastructure
workflow builds and lints every template (a warning fails it), runs `scripts/check-params.sh`
and ShellCheck. After the merge, a subscription Owner deploys it:

```bash
scripts/provision.sh prod
```

Removing a resource from the templates deletes it on that deployment. A new setting goes in
`infra/main.bicepparam` as a `readEnvironmentVariable` and in `.azure/env.example`;
`scripts/check-params.sh` fails when the two disagree.

`scripts/teardown.sh <env>` deletes an environment: its stack, resource group, custom roles and
GitHub Environment, and purges the test vault of a non-prod environment. For prod it also deletes the zone and removes the repository secrets, so the
Deploy workflow builds without deploying until prod is bootstrapped again. A new zone gets new
name servers, and the registrar has to be updated.

## History

Until #54 the project ran in a resource group named `internetresearch`, deployed with
`az deployment sub create`. Prod moved into the `atlasrelay-prod` stack and the old group was deleted.

Until #56 the API ran as the site's managed functions and read the tables with the storage
account key. On 2026-09-30 prod moved to the linked Function App: the stack linked the app while
the managed functions were still deployed, then the site was uploaded without them, and `/api`
answered throughout. Shared-key access was then turned off and both keys renewed. A site can be
linked while it still has managed functions; the link takes over `/api` at once.

## Monitoring

API and browser telemetry go to App Insights `appi-atlasrelay-prod`, which stores it in the Log
Analytics workspace `log-atlasrelay-prod` (0.1 GB/day cap). The App Insights tables (`App*`) keep
90 days, set per table in `infra/platform.bicep`; the workspace default of 30 days applies to the
rest.

### What is collected

| Source | Tables | Contents |
| --- | --- | --- |
| Functions host | `AppRequests` | One row per API request: function name, status, duration. |
| `api/src/lib/telemetry.ts` | `AppTraces` | JSON log lines with an `event` field: `dependency` for every RIPE Atlas and Table Storage call (operation, status, duration), `transfer` for the outcome of every API transfer, and `error`. |
| `web/src/lib/telemetry.ts` | `AppPageViews`, `AppBrowserTimings`, `AppExceptions`, `AppDependencies`, `AppEvents`, all with role `web` | Page views by route, with the referring site and any utm tags; page load timings; uncaught errors and unhandled promise rejections; the API calls each page makes; and the actions listed under [Traffic](#traffic). |
| Availability test | `AppAvailabilityResults` | The home page, requested from 3 locations every 15 minutes. |

Nothing sent contains a request or response body, a RIPE Atlas API key, an email address, a user
id or a query string. The API replaces anything shaped like a UUID (every RIPE Atlas key is one)
or an email address in every log line, and logs an unexpected error by class, code and status,
never by message. The browser drops query strings and fragments from URLs, cuts the referrer to
its origin, applies the same replacement, sets no cookies and writes nothing to local or session
storage. The only values it takes from a query string are `utm_source`, `utm_medium` and
`utm_campaign`, lowercased, put through the same replacement and cut to 64 characters.
`api/test/telemetry.test.ts` and `web/test/telemetry.test.ts` check these rules. The public page
`/privacy` describes the same collection for visitors; change it with them.

The Functions host does not record dependencies for Node apps, so RIPE Atlas and Table Storage
calls are log lines rather than `AppDependencies` rows. `api/host.json` turns sampling off, so
every request and log line is kept, and drops host start-up and health-check lines below warning
level. Those lines were about 80% of the traces in September 2026, when the API still ran as
managed functions, most of them a storage health check that reported unhealthy on every start.

Browser telemetry is compiled in only when the build has `VITE_APPINSIGHTS_CONNECTION_STRING`,
so local and dev builds send nothing. The Deploy workflow passes the repository variable
`APPINSIGHTS_CONNECTION_STRING`, which `scripts/bootstrap.sh` sets from the Bicep output. The
SDK loads once the page has finished loading, so the first page's own API calls are not in
`AppDependencies`. Later calls are, and their `traceparent` header gives the API request the same
operation id. It sends in batches, and sends what is queued when the page is hidden or left. A
sign-in click does not rely on that, because a request made while the page is being replaced may
never arrive. The browser follows the link once the click has been sent, or after 1.5 seconds,
whichever comes first. The click goes as a keepalive request, so if time runs out it still
finishes after the page has gone. A click before the SDK has loaded starts the download at once, within the
same 1.5 seconds. If the SDK or the ingestion endpoint is blocked, the link is followed anyway.
Ctrl-, Cmd- and middle-clicks open a tab and are not held. A visitor who closes the tab before the
SDK loads is not counted. `web/e2e/sign-in.spec.ts` checks this in a browser.

### Where to look

The workbook **Atlas Relay** (App Insights `appi-atlasrelay-prod`, Workbooks) has two tabs.
**Operations** shows page load times, API latency and failures, errors, availability, RIPE Atlas
and Table Storage calls, and transfer outcomes. **Traffic** shows visits, pages, referring sites,
campaigns, countries, devices, the pledge funnel and projects posted per week; see
[Traffic](#traffic).

From a terminal, `scripts/logs.sh` runs a saved query from `ops/queries` against the workspace
and prints a table. `scripts/logs.sh list` names the queries. It needs `az` and `jq`; set
`SUBSCRIPTION_ID` if the workspace is not in az's current subscription and there is no
`.azure/prod/.env`. `ATLASRELAY_ENV=dev` reads the dev workspace.

```bash
scripts/logs.sh api-errors          # 5xx by function, and API error lines (last day)
scripts/logs.sh transfers 7d        # API transfers and their outcome
scripts/logs.sh ripe-atlas 6h       # RIPE Atlas calls by path and result
scripts/logs.sh browser-exceptions  # browser errors by message
scripts/logs.sh traffic 7d          # page loads per day, top pages, referrers, campaigns, countries
scripts/logs.sh actions 30d         # the pledge funnel and other actions
```

### Traffic

The Traffic tab, `scripts/logs.sh traffic` and `scripts/logs.sh actions` read `AppPageViews` and
`AppEvents` (role `web`), and `AppRequests` and `AppTraces` for the API's own counts.

- **Page load**: one visit in one browser tab, counted by the random id each page load gets
  (`SessionId`). Reloading, opening a second tab or coming back tomorrow starts a new one. With no
  cookies and no user id there is no count of unique or returning visitors, and there cannot be one
  without adding them.
- **Page view**: one route shown. Moving around the site adds page views to the same page load.
- **Referring site** (`Properties.referrerOrigin`): on the first page view of a page load, the
  origin of the page that linked here. `direct` means the browser sent no referrer: a typed or
  bookmarked address, a link in an email or chat app, or a site that withholds referrers.
  `internal` marks later page views, and page loads that started from another page of this site.
  Someone coming back from a first-time GitHub or Microsoft sign-in may show up with github.com or
  a Microsoft login host as the referrer. Page views from before this was recorded show
  `(not recorded)`.
- **Campaign** (`Properties.utm_source`, `utm_medium`, `utm_campaign`): copied from the landing URL
  onto every page view of that page load. Tag the links you post, for example
  `https://atlasrelay.org/?utm_source=ripe-atlas-list`, and the page loads they bring count
  under that source. Other query parameters are never read.
- **Country, device, browser**: App Insights works out the location from the IP address when the
  data arrives and stores the address as `0.0.0.0`. Device is Mobile for iOS and Android and
  Desktop otherwise; `ClientType` reads "PC" for every browser, so it is not used.
- **Bots**: browsers whose name contains bot, crawler or spider, and headless Chrome, are left out
  of every count and shown on one tile. Crawlers that do not run JavaScript never appear at all.

Actions are `AppEvents` rows. Each also carries `page`, the route it happened on.

| Event | Sent when | Properties |
| --- | --- | --- |
| `pledge-started` | "Send credits" opens the pledge form | `projectId` |
| `pledge-completed` | The API accepted a pledge: RIPE Atlas accepted an API transfer, or a manual pledge was recorded and the donor shown the address. Whether a manual donor then sends is not tracked. | `projectId`, `method` (`api` or `manual`), `amount` (`1-999`, `1000-9999`, ... `1000000+`) |
| `project-posted` | A new project was saved | `projectId` |
| `sign-in-clicked` | A `/.auth/login/...` link was followed | `provider` (`github` or `aad`) |
| `outbound-click` | A link to atlas.ripe.net was clicked or middle-clicked | `host`, `path` (up to three segments, numbers as `:n`) |

A project page view is a page view named `/projects/:id`; its `Url` holds the project id, so there
is no separate event for it. Pledge amounts are sent as a power-of-ten range because the exact
amount, date and name of every pledge are public, and an exact amount would match one pledge row.

The browser only counts visitors whose browser loaded the telemetry and could reach App Insights;
content blockers stop both. The API counts (201 answers from `pledges-create` and
`projects-create`, and `transfer` lines with outcome `confirmed` or `unrecorded`) include everyone,
so quote those for how many pledges and projects there were. The funnel compares browser counts
with browser counts, and `actions` shows the API count beside them. Never add the two.

What these numbers cannot tell you: unique or returning visitors, time on the site, visits from
browsers that block App Insights or do not run JavaScript, and what people searched for. Google
Search Console has search queries. Static Web Apps keeps no access logs, so there is no
server-side count of page requests to compare with.

### Alerts

Every alert emails the address in the setting `ATLASRELAY_ALERT_EMAIL`
(`scripts/bootstrap.sh --alert-email`), through the action group `ag-atlasrelay-prod`. Without
that setting the stack deploys no action group and no alerts.

| Alert | Fires when | Severity |
| --- | --- | --- |
| Home page unavailable | The availability test fails from 2 of its 3 locations. | 1 |
| API transfer outcome unknown or unrecorded | Any API transfer ends `uncertain` or `unrecorded`. | 1 |
| API server errors | At least 3 requests answer 5xx in 15 minutes, and at least 10% of requests. | 2 |
| RIPE Atlas API not answering | At least 2 RIPE Atlas calls time out, fail to connect or return 5xx in 30 minutes. | 3 |
| API error log lines | At least 3 API error lines or exceptions in 30 minutes. | 3 |
| Browser errors | At least 5 uncaught browser errors from at least 2 page loads in an hour. | 3 |

For a transfer alert, `scripts/logs.sh transfers` gives the project and pledge ids. An `uncertain`
transfer is the case in [A pledge stuck at "Sent, outcome unknown"](#operations). `unrecorded`
means RIPE Atlas accepted the transfer and both attempts to write the confirmation failed; the
donor was told not to send again, and the owner can confirm the pledge once the credits arrive.

The "Failure Anomalies" rule that App Insights created by itself sends to its own action group,
"Application Insights Smart Detection". That group notifies holders of the Monitoring Contributor
and Monitoring Reader roles, and nobody holds either on this subscription.

### Changing monitoring

The alerts, availability test, action group and workbook are declared in `infra/monitoring.bicep`,
a module of `infra/main.bicep`, and deployed with the rest of the stack by `scripts/provision.sh`.
The availability test requests the site's own hostname until the apex is bound (its token is
recorded), and `https://atlasrelay.org/` after that. The alert queries, the workbook and
`ops/queries` read the JSON field names that `api/src/lib/telemetry.ts` writes, so change them
together. The Traffic tab reads the page view properties and event names that
`web/src/lib/telemetry.ts` sends, and its action table is `ops/queries/actions.kql` word for word.

`infra/workbooks/atlasrelay.json` is the workbook in the portal's own format. To change it, edit
the workbook in the portal, open the Advanced Editor, copy the Gallery Template JSON into that
file, replace the workspace's resource id with `__WORKSPACE_ID__`, and run
`scripts/provision.sh prod`.

## Operations

- **Logs**: see [Monitoring](#monitoring). Bicep writes the Function App's app settings,
  `APPLICATIONINSIGHTS_CONNECTION_STRING` included; do not set app settings by hand, the next
  stack deployment replaces the whole map. Extra settings go in the `additionalAppSettings`
  parameter.
- **Storage keys**: neither storage account accepts its keys, and nothing stores one, so there is
  nothing to rotate. Renewing them anyway changes nothing for the site.
- **Direct requests to the Function App**: a request straight to the Function App's hostname is
  refused, with or without an `x-ms-client-principal` header. The Deploy workflow checks this after
  every deploy with a forged header; to check without one by hand:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' "https://$(scripts/settings.sh prod FUNCTION_APP_HOSTNAME)/api/stats"   # 401 or 403
  ```

  A 200 means the link's identity provider is gone from the Function App (App Service
  authentication, provider "Azure Static Web Apps (Linked)"). Deploy the stack again with
  `scripts/provision.sh prod`; if that does not bring it back, set `ATLASRELAY_API_UNLINKED=true`,
  deploy, then clear it and deploy again to relink.
- **Rotate SWA deploy token**: `az staticwebapp secrets reset-api-key` (an Owner; the
  CI role cannot). Nothing else to do; workflows fetch the token on every run.
- **Change infrastructure**: see [Changing infrastructure](#changing-infrastructure).
- **Table access by hand**: the commands below sign in as you (`--auth-mode login`), because the
  accounts refuse keys. They need Storage Table Data Contributor on the data account, which the
  stack grants to the object id in `ATLASRELAY_OPERATOR_PRINCIPAL_ID`. Owner on the subscription
  alone gives no access to rows. To hand it to someone else, set that setting to their object id
  and run `scripts/provision.sh prod`.
- **Data export**: `az storage entity query --table-name projects --account-name <storage account>
  --auth-mode login ...`, or Azure Storage Explorer signed in with the same account.
- **Owner index rows**: the `projects` table holds two kinds of row. Projects are in partition
  `project`; each owner also has a partition `owner-<user id>` with one row per project they
  posted, which the open-project cap, the owner's dashboard and profile deletion read instead of
  scanning the table. Filter exports on `PartitionKey eq 'project'`.
- **Take a project down**: there is no admin console, so this is done against Table Storage.
  Closing a project stops it accepting credits. Setting `moderationClosed` as well takes it off
  every listing and the sitemap, and its page answers 404 to everyone. `GET /api/projects/<id>`
  answers 404 too, except to the owner, so a signed-in owner still sees the project in the app
  and can settle its pledges. It is reversible, so prefer it to deleting anything. Browsers and
  proxies may keep the old page for up to a minute.

  ```bash
  az storage entity merge --table-name projects --account-name <storage account> --auth-mode login \
    --entity PartitionKey=project RowKey=<project id> status=closed \
              moderationClosed=true moderationClosed@odata.type=Edm.Boolean
  ```

  Set both `status` and `moderationClosed`. With `status` alone the owner can reopen the project
  from the edit form; `moderationClosed` makes the API refuse that, and only this command can
  clear it (`moderationClosed=false`).

  To remove the owner as well, delete their row from `users`, which also removes the stored RIPE
  NCC Access email. Find the id from the project's `ownerId`, then:

  ```bash
  az storage entity show --table-name users --account-name <storage account> --auth-mode login \
    --partition-key user --row-key <owner id>
  az storage entity delete --table-name users --account-name <storage account> --auth-mode login \
    --partition-key user --row-key <owner id>
  ```

  Close every project they own first, using the command above: deleting the user alone would leave
  projects advertised as pledgeable that nobody can pledge to, because the handler needs
  the owner's address to name a recipient. Their projects and pledges stay, carrying only a display
  name, because other people's records point at them. The internal account id stays on those rows,
  so the same GitHub or Microsoft account signing in again is reconnected to that history; deletion
  is not a ban. Record what you did and why in the abuse issue, since there is no other audit
  trail.
- **A pledge stuck at "Sent, outcome unknown"**: the API posted a transfer and got no usable
  answer (a timeout, a network failure or a 5xx from RIPE), so the site cannot tell whether the
  credits moved. Only the requester can settle it: confirm the pledge if the credits arrived,
  cancel it if they did not. The donor cannot, because cancelling frees their slot and a new
  pledge could send the same credits twice; they should check
  https://atlas.ripe.net/credits/transactions/ and tell the requester. No operator action is
  needed. Unlike other pending pledges, an uncertain one does not expire after 14 days: it keeps
  its reserved credits and the donor's slot until the requester settles it. The flag stays set
  after settlement, so filter on status as well. To list the unsettled ones:

  ```bash
  az storage entity query --table-name pledges \
    --filter "transferUncertain eq true and (status eq 'pledged' or status eq 'sent')" \
    --account-name <storage account> --auth-mode login
  ```

  Several at once usually means RIPE was unreachable or slow. Check App Insights for a matching
  spike of 502s before changing anything.

## Search engines

- **Pages and status codes**: the build writes one HTML file per kind of page from
  `web/index.html` (`web/src/lib/pages.ts`, run from `web/vite.config.ts`): `index.html` for the
  home page, `shell/projects.html`, `shell/how-it-works.html`, `shell/privacy.html`,
  `shell/project.html` (the template for project pages), `shell/app.html` for the pages behind
  sign-in, and `404.html`. Each has its own title and description, and a line of text inside
  `#root` for clients that do not run JavaScript. The home, projects, how-it-works and privacy
  files carry a canonical URL, and the sign-in and not-found files carry `noindex` instead. `staticwebapp.config.json` rewrites each
  route to its file. There is no navigation fallback, so any other path gets `404.html` with a
  404 status. Adding a route to `web/src/App.tsx` means adding a rule for it too;
  `web/test/seo.test.ts` fails until you do.
- **Project pages**: `/projects/*` (after the rules for `/projects` and `/projects/new`) is
  rewritten to the `project-page` function, which reads the id from the `x-ms-original-url`
  header and answers:

  | Request | Status | Page | `cache-control` |
  | --- | --- | --- | --- |
  | `/projects/<id>`, project exists and is not taken down | 200 | Project shell with the project's title, summary, canonical URL and `og:url` | `public, max-age=60` |
  | `/projects/<id>/edit` with a well-formed id | 200 | Project shell with the edit form's title and `noindex` | `public, max-age=60` |
  | Unknown id, taken-down project, malformed id, any other path | 404 | `404.html`, `noindex` | `public, max-age=60` |
  | Storage failed, or the header was missing | 200 | `shell/project.html` with `noindex` | `no-store` |

  The function starts from `shell/project.html` and `404.html` as the same build wrote them:
  `api/bundle.mjs` embeds both in the API bundle, so the web app has to be built before the API
  (`npm run build` does this). SWA does not add `globalHeaders` to function responses, so the
  function sets the CSP and the other security headers itself; `api/test/projectPage.test.ts`
  fails if they drift from the config. The last row logs `Project page: could not read the
  project` or a `project-page` event with `outcome: no-original-url`. Either one on every request
  means the page heads are generic but the site still works. `robots.txt` still disallows
  `/projects/*/edit`.
- **Trailing slashes**: the docs say `trailingSlash: "never"` redirects `/how-it-works/` to
  `/how-it-works` with a 301. In production it does not: SWA answers the path with the slash
  with the same page and a 200, and the canonical tag names the path without it. The project page
  function does the same for `/projects/<id>/`.
- **Sitemap**: `/sitemap.xml` is rewritten to `GET /api/sitemap`, which lists the home page, the
  project list, the how-it-works and privacy pages and every project an operator has not taken down
  (`moderationClosed`). Responses may be cached for an hour. If storage fails it answers 503.
- **IndexNow**: after a production deploy, the `indexnow` job in `deploy.yml` reads the live
  sitemap and posts its URLs to `https://api.indexnow.org/indexnow`. The key is the name and the
  content of the 32-hex-digit `.txt` file in `web/public`. To rotate it, replace that file with a
  new one. The job logs problems as warnings and never fails the run.
- **Share image**: `web/public/og-image.png` is a 1200x630 screenshot of the home page hero,
  taken with Playwright with the statistics tiles and navigation hidden.

## Adding an admin role later

Static Web Apps supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
