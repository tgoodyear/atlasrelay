# Runbook

## Environments

Everything in Azure is one deployment stack per environment, `atlasrelay-<env>`, at subscription
scope, declared in `infra/main.bicep`. `prod` serves atlasrelay.org. `dev` is optional and is
deployed from the same template. Environment names are 1 to 6 lowercase letters and digits, starting with a letter.

| Resource | prod | Declared in |
| --- | --- | --- |
| Resource group | `rg-atlasrelay-prod` | `infra/main.bicep` |
| Static Web App (Standard) | `swa-atlasrelay-prod` | `infra/app.bicep` |
| Sign-in vault (client secrets and ids) | `kvs-atlasrelay-prod-<4 characters>` | `infra/signin.bicep` |
| The site's identity for signing in to Microsoft Entra | `id-atlasrelay-prod-signin` | `infra/app.bicep` |
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
| Key Vault for the test accounts, no public network access, with a private endpoint | `kv-atlasrelay-dev-<6 characters>`, `pe-atlasrelay-dev-kv` | `infra/testharness.bicep` |
| Test identity: reads the vault's secrets, writes the results, renews the lock | `id-atlasrelay-dev-e2e` | `infra/testharness.bicep` |
| Storage account for test results, containers `results` and `locks`, Entra ID only | `stare2edev<6 characters>` | `infra/testharness.bicep` |
| Container Apps environment in `snet-cae`, and the test job | `cae-atlasrelay-dev`, `caj-atlasrelay-dev-e2e` | `infra/testharness.bicep` |
| Custom roles for the CI identity, its read access to the results and its write access to the lock | "Atlas Relay e2e runner (dev)", "Atlas Relay e2e image builder (dev)" | `infra/testharness-rbac.bicep` |

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

The settings file holds values the repository does not: the apex validation token, the
subscription the environment lives in, and the sign-in client ids. Keep it; `scripts/teardown.sh`
renames it rather than deleting it. It holds no secrets: the sign-in client secrets are in a vault
([Sign-in registrations](#sign-in-registrations)).

## First deployment

Prerequisites: `az` 2.61 or later, signed in as an Owner of the subscription
(`az login --tenant <tenant-id>`); `gh`, signed in as an admin of the
repository; `jq`, `dig` and Node 24.11+.

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
GitHub account. Node 24.11 or newer is required; newer major versions work with a warning
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
npm ci && VITE_SIGNIN_PROVIDERS="$(scripts/settings.sh dev SIGNIN_PROVIDERS)" npm run build
rm -rf api-deploy api.zip && mkdir -p api-deploy/dist
cp api/dist/bundle.js api-deploy/dist/ && cp api/host.json api/package.json api-deploy/
(cd api-deploy && zip -qr ../api.zip .)
az functionapp deployment source config-zip -g rg-atlasrelay-dev --subscription <id> \
  -n "$(scripts/settings.sh dev FUNCTION_APP_NAME)" --src api.zip
TOKEN=$(az staticwebapp secrets list -n swa-atlasrelay-dev -g rg-atlasrelay-dev \
  --subscription <id> --query properties.apiKey -o tsv)
npx swa deploy web/dist --deployment-token "$TOKEN" --env production
```

The full-flow tests also put their build on dev before they run (`scripts/run-e2e.sh dev`, or the
workflow `e2e-dev.yml`), holding the lock described in
[One run at a time](#one-run-at-a-time). A deploy by hand does not take that lock. While a test
run holds it, a build you put on dev replaces the one under test, so check that no run is going
first: `az storage blob show --auth-mode login --account-name "$(scripts/settings.sh dev
E2E_RESULTS_ACCOUNT)" -c locks -n full-flow --query properties.lease.state -o tsv` prints
`leased` while one is.

`scripts/teardown.sh dev` removes it again, the CNAME and the test harness included.

## Sign-in registrations

The site signs people in with its own app registrations at GitHub, Microsoft, Google and ORCID,
one set for dev and another for prod. Static Web Apps also has built-in GitHub and Microsoft
providers that need no registration, and a build without registrations uses those. Google and ORCID
need registrations, and Microsoft's documentation says that "using any custom registrations
disables all preconfigured providers"
([custom authentication](https://learn.microsoft.com/azure/static-web-apps/authentication-custom)),
so GitHub and Microsoft need their own too. [Sign-in providers](ARCHITECTURE.md#sign-in-providers)
explains the design.

Where things live:

- **Client ids**: in the settings file (`ATLASRELAY_<PROVIDER>_CLIENT_ID`), in the sign-in vault
  (`signin-<provider>-client-id`, with `microsoft` for Microsoft), and in the site's app settings.
  They are not secret. `scripts/provision.sh` takes a client id missing from the settings file
  from the vault, and warns when the two differ.
- **Client secrets** for GitHub, Google and ORCID: in the environment's sign-in vault,
  `SIGNIN_KEY_VAULT_NAME` (`kvs-atlasrelay-<env>-...`, `infra/signin.bicep`). The site's app
  settings hold Key Vault references to them, without a version, and the site reads them with its
  system-assigned identity
  ([Key Vault secrets](https://learn.microsoft.com/azure/static-web-apps/key-vault-secrets)). No
  secret is in the settings file, the Bicep parameters, the deployment history or a log.
- **Microsoft has no secret.** The site signs in to Entra with its user-assigned identity
  `id-atlasrelay-<env>-signin`, which the app registration trusts through a federated identity
  credential (`OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID`, "Use a managed identity instead of a
  secret" in [custom authentication](https://learn.microsoft.com/azure/static-web-apps/authentication-custom)).
- **Which providers a build offers**: `SIGNIN_PROVIDERS`, worked out from the client ids by
  `scripts/provision.sh`, and copied to the repository variable the workflow that builds the
  environment reads (`SIGNIN_PROVIDERS` for prod, `DEV_SIGNIN_PROVIDERS` for dev).

Every redirect URI has the form `https://<host>/.auth/login/<provider>/callback`, with the
providers `github`, `aad`, `google` and `orcid`. For prod the host is `atlasrelay.org`; make the
apex the default domain first ([Canonical host](#canonical-host)) so that `www` and the
`azurestaticapps.net` name redirect to it; `scripts/register-signin.sh prod` checks both. For dev
there are two hosts, and each needs its redirect URI, because Static Web Apps sends the provider
the callback on the hostname the sign-in started from: the site's own hostname
(`scripts/settings.sh dev SWA_HOSTNAME`), which the full-flow tests use, and `dev.atlasrelay.org`.

### Registering

Run it in a terminal, signed in to Azure as an Owner of the subscription who may create app
registrations in its tenant, and to GitHub with `gh`:

```bash
scripts/register-signin.sh dev
```

It goes through the providers in turn:

1. **Microsoft.** It creates or updates the Entra app registration "Atlas Relay (dev)" ("Atlas
   Relay" for prod) with Microsoft Graph. It sets:
   - accounts in any organization and personal Microsoft accounts;
   - the redirect URI, and ID tokens on: Static Web Apps asks for `code id_token`, and with ID
     tokens off, Microsoft's answer made the site show "401: Unauthorized" after a good sign-in
     (seen on dev, 2026-10);
   - the home page, privacy and support links;
   - the site's icon as the logo;
   - the sign-in permissions `openid` and `profile`. The site asks for no email address
     (`scope=openid profile` in `web/src/lib/signin.ts`), and `prompt=select_account` lets a
     person pick another account after signing out.

   It then adds a federated identity credential that trusts the site's sign-in identity, and adds
   no client secret. Graph cannot set the publisher domain ("Property 'publisherDomain' is
   read-only"), so the script lists that as a step for the admin center: open the app's
   **Branding & properties** and set **Publisher domain** to `atlasrelay.org`, a verified domain of
   the tenant.
2. **GitHub.** It opens a page that sends a GitHub App manifest to github.com. Check the name there
   (GitHub App names are unique across GitHub), then choose **Create GitHub App**. GitHub sends the
   browser back to the script, which stores the client id and writes the client secret to the
   vault. The app asks for no permissions and has no webhook.
3. **Google.** It prints what to set up in the Google Cloud console:
   - **Branding:** the app name, a support email, the home page and the privacy page;
   - **Audience:** External, then **Publish app**;
   - **Clients:** a Web application client with the redirect URI.

   It then asks for the client id and, without showing it, the client secret.
4. **ORCID.** It prints what to register under Developer tools on orcid.org, then asks for the
   client id and, without showing it, the client secret. Each ORCID account has one public API
   client, so dev and prod share it. Outside dev, the script takes dev's client id from dev's
   settings and copies its secret from dev's sign-in vault, without asking; add the environment's
   redirect URI to the client on orcid.org, which it lists at the end. The site's account name for an ORCID
   sign-in is the ORCID iD: Static Web Apps refuses a sign-in without one ("403: We need an email
   address or a handle from your login service"), and ORCID's token has no email address.

It also writes each client id it records to the vault.

Once GitHub and Microsoft are both registered, it deploys the stack (`scripts/provision.sh`) with
the client ids. That writes the app settings that point into the vault, and it also tells the API
which providers to accept. It records `SIGNIN_PROVIDERS` and sets the repository variable. Then it
prints where each `/.auth/login/<provider>` leads on the live site.

`scripts/register-signin.sh dev google` registers one provider. The settings and the vault keep the
others.

### Putting it live

App settings alone change nothing a visitor sees. The site keeps its built-in providers until a
build that names the new ones is deployed. The order matters the other way too: while the live
build names an app setting that does not exist, Static Web Apps answers 404 for every
`/.auth/login/<provider>`, not only the one that lacks it (seen on dev, 2026-10).

- Dev: `scripts/run-e2e.sh dev` builds with `SIGNIN_PROVIDERS`, deploys to dev and runs the
  full-flow tests, which sign in with Microsoft through the new registration. The `e2e-dev.yml`
  workflow builds with `DEV_SIGNIN_PROVIDERS`.
- Prod: run the Deploy workflow (`gh workflow run deploy.yml --repo tgoodyear/atlasrelay --ref
  main`), which builds with `SIGNIN_PROVIDERS`.

Afterwards each provider's sign-in leads to it, and `/.auth/me` shows the provider once signed in:

```bash
for p in github aad google orcid; do
  curl -s -o /dev/null -w "$p %{http_code} %{redirect_url}\n" "https://<host>/.auth/login/$p" | cut -c1-90
done
```

Before prod has users, switching changes nothing for anyone. After that, check on dev first that an
existing GitHub and Microsoft account keeps its `userId` (in `/.auth/me`) across the switch. If it
changes, people would get a new, empty account, and their projects and pledges would stay with the
old one.

The Microsoft registration's publisher is not verified (Microsoft Partner Network publisher
verification is not done). Organizations that let their users consent only to apps from verified
publishers show those users "Need admin approval" instead of signing them in; an admin of that
organization can consent for it. The full-flow tests stop with that message when Microsoft shows
it.

### Signing out

The site's "Sign out" link is `/logout`. With the site's own registrations it leads to
`/.auth/logout/complete`, which clears the site's sign-in cookie and comes back to the home page.
The platform's own `/.auth/logout` sent a Microsoft sign-in to Microsoft's sign-out page, which ends
the person's whole Microsoft session in that browser, and on dev (2026-10) never came back to the
site, so the site's cookie stayed and the person stayed signed in. The provider's own session is
left alone, as with the built-in providers: signing in with Microsoft again asks which account to
use (`prompt=select_account`). The full-flow tests on dev check that signing out ends the session
(`e2e-real/specs/sign-out.spec.ts`).

### Rotating a secret

```bash
scripts/register-signin.sh prod --rotate github     # GitHub, Google, ORCID: paste a new secret
```

Microsoft has no secret to rotate: its credential is the site's managed identity. For GitHub,
Google and ORCID, create the new secret with the provider, paste it when asked, and delete the old
one there once sign-in works. ORCID replaces the secret in place, so ORCID sign-in fails from the
reset until the new secret is stored. Dev and prod share the ORCID client, so rotating it in either
environment also stores the new secret in the other's vault (from the settings in `.azure/`); one
it can't reach is listed at the end, to rotate there with the same secret.

The app settings name the secret without a version, so a rotated secret needs no deployment. When
Static Web Apps picks up the new version is not documented; sign in to check before deleting the
old secret with the provider.

If a secret leaks, rotate it at once and delete the old one with the provider. A client secret
lets someone act as the site's registration with that provider: for GitHub, for example, it can
check, reset or revoke the tokens people granted the app. On its own it does not let anyone sign in
to this site as somebody else, because the provider sends sign-in codes only to the registered
redirect URIs. None of these secrets reaches an Azure resource or data.

The identity the site signs in to Microsoft with can get tokens as the Entra app registration, and
nothing else: it has no Azure role, and only the site holds it. The registration has no
application permissions and no Azure role assignments, and should get none.

### The vault

`kvs-atlasrelay-<env>-...` uses Azure RBAC only. The site's system-assigned identity has Key Vault Secrets
User and the operator (`ATLASRELAY_OPERATOR_PRINCIPAL_ID`) has Key Vault Secrets Officer. Public
network access stays on because Static Web Apps reads the secrets from outside any virtual
network. Its audit log (`AuditEvent`) goes to the environment's Log Analytics workspace:

```kusto
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT" and Resource startswith "KVS-"
| project TimeGenerated, OperationName, CallerIPAddress, identity_claim_oid_g, ResultSignature
```

Purge protection is on, so nobody can purge the vault or its secrets during the 7-day retention
period. `scripts/teardown.sh` leaves the deleted vault recoverable, and the next deployment of the
environment recovers it, secrets included, but not its role assignments: see "Rebuilding a torn-down
environment".

### Turning them off

The build has to change first, then the settings. Taking settings away while the live site still
names them breaks sign-in with those providers, GitHub and Microsoft included. `scripts/provision.sh`
reads from Azure which sign-in settings the live site has, and refuses to remove any of them without
`SIGNIN_REMOVAL_OK=1`, even when the local settings file is an older copy.

1. Prod: delete the repository variable `SIGNIN_PROVIDERS` (or set it to the providers that stay,
   GitHub and Microsoft always among them), and run the Deploy workflow. Dev: `scripts/run-e2e.sh
   dev` builds from the local setting, not the repository variable, so set both: the setting
   (`scripts/settings.sh dev SIGNIN_PROVIDERS ""`, or the providers that stay) and
   `DEV_SIGNIN_PROVIDERS`, then run `scripts/run-e2e.sh dev`. Either way, wait until the new build
   is live (`/.auth/login/<provider>` answers 404 for each provider that goes) before step 2.
2. Clear the client ids that go (`scripts/settings.sh prod ATLASRELAY_ORCID_CLIENT_ID ""`), then
   `SIGNIN_REMOVAL_OK=1 scripts/provision.sh prod`. A client id set to empty stays empty; one missing
   from the settings file altogether is taken back from the vault's `signin-<provider>-client-id`, so
   delete that secret too if other copies of the settings should not bring the provider back.
3. Delete the registrations with the providers. The secrets can stay in the vault or be deleted
   there.

Going back to the built-in providers can change people's `userId` just as switching away can.

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

`e2e-real/` signs two test accounts into the dev site through the real Microsoft sign-in page and
runs the flow there. It uses the site's own hostname (`scripts/settings.sh dev SWA_HOSTNAME`), not
dev.atlasrelay.org: a newly bound custom domain can answer the platform's 404 on some requests for
hours, and a test run should not wait on that. It runs with the page steps the local full-flow
tests use (`web/e2e/ui.ts`). It has three spec files:

- `full-flow.spec.ts`: the researcher saves a profile and posts a project, the donor pledges to
  transfer by hand and marks the credits sent, the researcher confirms them and posts results, and
  a signed-out visitor sees the funded project without the researcher's email. No credits move.
- `manual-verify.spec.ts`: a manual pledge checked with RIPE Atlas. The donor pledges by hand, the
  test sends the credits with the donor key straight to RIPE Atlas, and the researcher confirms with
  the recipient key in the confirm dialog. One test sends the pledged amount and expects the pledge
  verified; the other sends less and expects the site to offer the amount that arrived, which the
  researcher records. Each test sends its credits back, as `ripe-transfer.spec.ts` does, and prints
  how the live RIPE Atlas API listed the transfer: the row's type, sign and text, how long it took
  to appear, and whether both sides share a transaction id.
- `ripe-transfer.spec.ts`: real RIPE Atlas transfers between two RIPE Atlas test accounts, through
  the site's "Transfer now with an API key" form. See [Real RIPE Atlas transfers](#real-ripe-atlas-transfers).

Each spec file deletes both profiles before and after its tests (`ripe-transfer.spec.ts` and
`manual-verify.spec.ts` around each test). It also deletes the projects the run posted, through the
test-only route `DELETE /api/test/projects/{id}`, whether or not the test passed, and prints
`[cleanup] deleted N project(s): <ids>`. A run that could not delete one fails and names it. The
route closes a project on the first call and deletes it on a later one, at least two minutes on, so
no pledge request that started before the close can still be running. The two specs that move real
credits close each test's project in a hook after the credit return and before the profiles go, and
wait for the deletions once, in an `afterAll` hook, which runs even when an `afterEach` hook timed
out (the credit return, at worst), which skips the hooks declared after it. The cleanup adds about
two minutes to each spec file. The route exists only where `E2E_PROJECT_CLEANUP=1`,
which the environment's stack sets on every environment except prod
([Test cleanup](ARCHITECTURE.md#test-cleanup)). A run against an environment last deployed before
that fails its cleanup with HTTP 404 until `scripts/provision.sh` deploys it again.

Projects left by runs from before the tests cleaned up after themselves are removed with
`scripts/purge-test-data.sh`, signed in as the operator (Storage Table Data Contributor on the data
account). It finds the test accounts from the projects the tests posted, prints what it would
delete, and deletes only with `--apply`. It refuses prod.

```bash
scripts/purge-test-data.sh dev            # dry run: accounts, counts, what is left afterwards
scripts/purge-test-data.sh dev --apply    # delete
```

An account that owns any project the tests did not post is left out and named in the output, and so
is a donor that pledged to a test project and also pledged elsewhere, whatever name it pledged
under. Pass
`--account <id>` (repeatable) to purge only the accounts you name instead of the ones it finds, so
name every account you want purged. `/api/stats` is sent with `max-age=300`, so a browser can show
the old home-page figures for up to five minutes, and once more after that while it fetches new
ones.

Each run tests the build it deploys. `.github/workflows/e2e-dev.yml`:

1. builds the site and the API at the commit, in a job without an Azure identity;
2. in the GitHub Environment `dev`, signs in to Azure as the dev CI identity (OIDC);
3. builds the test image from `e2e-real/Dockerfile` in dev's container registry
   `cratlasrelaydev<6 characters>` with ACR Tasks, tagged with the commit. The image is private: the
   registry has no admin user and no anonymous pull, and only the test identity is granted AcrPull;
4. takes the lock, waiting up to 45 minutes for a run that holds it
   ([One run at a time](#one-run-at-a-time));
5. publishes the API to dev's Function App, uploads the site with dev's deployment token (the
   Static Web Apps upload client runs as an ACR Tasks run in dev's registry, so it works the same
   from a Mac without Rosetta), and waits until the site serves the new build;
6. starts the Container Apps job `caj-atlasrelay-dev-e2e` with the image, pinned by digest, and
   the lock's lease;
7. waits for the execution (the job gives a run 45 minutes, and never retries), then releases the
   lock;
8. downloads the results from the storage account's `results` container, uploads only
   `summary.json` as the run's artifact, and fails the run unless every test passed.

Steps 3 to 7 are `e2e_run` in `scripts/lib/e2e-job.sh`, which `scripts/run-e2e.sh` runs too.

Inside the job, `e2e-real/run.mjs` reads the accounts and the RIPE Atlas keys from the Key Vault
`kv-atlasrelay-dev-<6 characters>` as the job's identity, through the vault's private endpoint,
signs both accounts in once (`e2e-real/global-setup.ts`, outside any trace or report), runs the
suite, and replaces every secret with `[redacted]` in the output and in every result file, trace
archives included, before uploading. The secrets are the passwords, the TOTP seeds, the two RIPE
Atlas keys, the two RIPE account emails and the site's session cookies. GitHub never holds any of
them, and the CI identity has no role on the vault.

#### One run at a time

dev has one site, one API and one set of tables, and every run deploys its own build there before
it tests. Two runs at once would test each other's builds, sign the same accounts in, delete each
other's profiles and misread each other's credit transfers. So a run, whether the workflow or
`scripts/run-e2e.sh` started it, holds a lock from before it deploys until its tests end: a
60-second lease on the blob `full-flow` in the `locks` container of the results storage account
(`e2e-real/lib/lock.mjs`).

- The orchestrator (the workflow's `run` job, or `scripts/run-e2e.sh` on your machine) takes the
  lease before it deploys. `e2e-real/lock-holder.mjs` renews it every 20 seconds in the
  background, and writes the run's id, commit and the time it took the lock on the blob, which a waiting run
  prints. Nothing about the person who started it is written.
- The test job is started with the lease's id (`E2E_LOCK_LEASE_ID`) and renews that same lease
  while its tests run. It never takes a new one then, and it does not release it.
- The orchestrator releases the lease once the execution has ended. If it stops early (an error,
  Ctrl+C, a cancelled workflow run), it first waits for an API deployment in progress to end and
  cancels a site upload in progress, then releases the lease, unless the job is still running:
  then it only stops renewing, and the job keeps the lease until it ends. The registry stops an
  upload 20 minutes after it starts. An API deployment that has not ended by then is reported,
  and the lease is left to lapse instead of being released; check dev's build before the next run.
  A deploy request that got no answer may still have started, so the orchestrator keeps the lock
  for those 20 minutes before it lets go.
- Before it builds anything, the orchestrator checks that the job's `LOCK_CONTAINER_URL` names the
  same lock, so the job renews the lease the orchestrator holds.
- A run that finds the lock held waits for it, checking every 30 seconds, for up to 45 minutes,
  then fails before it deploys anything. Start it again later.
- A holder that cannot renew (the blob service refuses the renewal, or two in a row fail) has lost
  the lock. The orchestrator deploys and starts nothing more; the job stops its tests the way
  Ctrl+C does, so the credit return still runs. The run fails.
- A job started from the portal, without a lease, takes the lock itself, waiting two minutes at
  most: the job's own 45-minute limit leaves no room for a longer wait.

This cannot deadlock, and the lock never needs breaking by hand. There is one lock, so no two runs
can each hold something the other is waiting for. A lease lasts 60 seconds unless someone renews
it, and only a live process renews it: the lock holder, which stops when its orchestrator exits
and after two hours at most, and the job, which Container Apps stops after 45 minutes. When every
holder of a run dies, the lock is free again within a minute. Every wait has a limit: 45 minutes
for the lock, 10 for the API deployment, 20 for the site upload, 5 for the site to serve the new
build and 55 for the execution.

#### Setting it up

Once per dev environment, as the Owner:

1. Bootstrap dev and put a build on it ([Dev environment](#dev-environment)). For `dev`,
   `scripts/bootstrap.sh` also deploys the harness, gives you write access to the vault's secrets
   (the setting `ATLASRELAY_OPERATOR_PRINCIPAL_ID`), makes the GitHub Environment `dev` wait for your
   approval, stores the identifiers the workflow reads as variables of that environment, and sets
   the repository variable `DEV_ENABLED=true`.
2. Create the test tenant and its two users. Creating a new Entra tenant from
   https://entra.microsoft.com now requires a paid license in the tenant you start from, so use a
   Microsoft 365 Developer Program sandbox instead (https://developer.microsoft.com/microsoft-365/dev-program):
   it is a tenant of its own, `<name>.onmicrosoft.com`, with an admin account.
   - Sign in to https://entra.microsoft.com as the sandbox's admin.
   - **Users**, **New user**: a researcher and a donor, for example
     `researcher@<tenant>.onmicrosoft.com` and `donor@<tenant>.onmicrosoft.com`, each with a long
     random password.
   - The test accounts sign in with a password and a TOTP code. Give each a TOTP seed
     ([Test account TOTP seeds](#test-account-totp-seeds)).
   - Sign in once with each test user at `https://<SWA_HOSTNAME>/login/microsoft` in a private
     window. Microsoft may ask for a new password (set one, and use that below) and whether the
     site may read the profile (accept).
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
   since the template declares public access off. Run it again to change a password.
4. Copy the RIPE Atlas keys into the vault ([Real RIPE Atlas transfers](#real-ripe-atlas-transfers)).
5. Run the workflow once (below).

#### Real RIPE Atlas transfers

`ripe-transfer.spec.ts` moves real credits between two RIPE Atlas accounts:

- the donor account holds the credits. The donor test user pastes its key into the pledge form,
  as a person would;
- the recipient account is the researcher's. The researcher test user puts its RIPE NCC Access
  email on the profile, so the site sends the credits there. The tests use its key directly with
  the RIPE Atlas API to check what arrived and to send it back. Only the second test, below,
  pastes it into the pledge form, when its balance is not above the donor key's.

Each key needs two permissions, "Transfer credits to another user" and "Get information about
your credits". Before any test, the job checks both on both keys: a read of `GET /credits/`, and a
transfer request with no recipient and no amount, which cannot move anything. It reads a 403 as
the permission missing and a 400 (RIPE refusing the empty request) as the permission present; any
other answer stops the file too. A missing permission stops the file with a message that names
the key and the permission to add at https://atlas.ripe.net/keys/.

The first test:

1. reads both balances, and fails if the donor account holds fewer credits than a run sends;
2. the researcher names the recipient account on the profile and posts a project;
3. the donor pastes the donor key, clicks **Check balance**, and transfers 100 credits
   (`E2E_RIPE_TRANSFER_CREDITS` changes the amount). The site must report the transfer and show
   the pledge as **Transferred via API**;
4. the recipient account's balance, read with the recipient key, must rise by that amount;
5. the researcher sees the pledge confirmed (an API pledge is confirmed by the site when RIPE
   accepts it, so there is nothing to click) and posts results, and a signed-out visitor sees the
   transfer and the results without the recipient email;
6. the recipient key sends the same amount back to the donor account with the RIPE Atlas API.

Step 6 runs in an `afterEach` hook with 3 minutes of its own, so a test that fails, times out or is
stopped after the credits moved still returns them. The hook closes the test's browser windows
before it looks at what happened, so a test that timed out cannot click **Transfer** once the hook
has read the outcome. If the site said the transfer went through, the credits go back. If the
test stopped before the site answered, they go back only when the recipient's balance shows them
arrived and the donor's balance fell. The return is one request, never retried; if it fails, the
run's output says `RETURN FAILED` and how many credits to send back by hand. A passing run leaves
both balances where they started, apart from whatever the accounts earn or spend on their own
meanwhile.

The second test pledges more than a key holds. It reads both balances and pays with the key whose
balance is lower, asking for that balance plus one. The project names the other account. The site
can refuse in one of two ways:

- when the key can read its balance, the site checks it before sending anything and shows "Your
  RIPE Atlas balance is N credits, less than the M you want to send";
- when the key cannot read its balance, the site sends the transfer and shows RIPE's refusal.

Both keys can read their balance (the permission check above), so the first is the path the job
runs; the second needs a key without the read permission, whose balance the test could not know.
The test expects the site's message, the form left open with the key field cleared, the pledge
cancelled and nothing received on the project. It then waits 90 seconds, since RIPE lists a
transfer in an account's transaction log 40 to 70 seconds after it moves the credits, and checks
that neither account's log shows a transfer of that amount since the test started, and that the
paying account's balance did not fall.

To set it up:

1. Create a key on each of the two RIPE Atlas accounts at https://atlas.ripe.net/keys/ with the two
   permissions above and nothing else. Set a validity window you are willing to renew; once it
   ends, the permission check stops the file.
2. Store each key in a Key Vault you can read, with the account's RIPE NCC Access email in the tag
   `ripe-user`. Use a vault that refuses every network (default action Deny, bypass None, no
   address or network rules, no private endpoints); `scripts/set-ripe-keys.sh` checks this, admits
   your address only while it reads the keys, and checks the vault is closed again afterwards. You
   need to be able to read the vault's secrets and to change its network rules (Contributor or
   Owner on the vault), including when it is in another subscription.
3. Copy them into the test vault, saying which is which:

   ```bash
   scripts/set-ripe-keys.sh dev --from-vault <vault> --donor <secret> --recipient <secret>
   ```

   `--donor` names the secret holding the key of the account with credits, `--recipient` the
   other. Add `--from-subscription <id>` when the source vault is in another subscription. The
   script reads each secret's `ripe-user` tag, prints the role, secret and account it will store,
   and asks before writing. It stores `ripe-donor-key`, `ripe-donor-account`, `ripe-recipient-key`
   and `ripe-recipient-account`, opening and closing the vault as `scripts/set-test-users.sh` does.
   The keys pass through the shell's memory, never the terminal, a file or a command line.
4. Seed the donor account: transfer a few thousand credits to it at
   https://atlas.ripe.net/credits/transfer/ if it holds fewer than a run sends. Runs net to zero,
   so this lasts.
5. `scripts/provision.sh dev`, if the job does not name the RIPE secrets yet (the variables
   `E2E_RIPE_*_SECRET` in `infra/testharness.bicep`). A job that names none skips the file and says
   so in its output.

#### Running it

The workflow runs after every push to `main` that changes `e2e-real/`, `web/e2e/ui.ts`,
`scripts/lib/e2e-job.sh` or the workflow, and by hand. It deploys the commit's site and API to dev
and tests them, so once a change to `web/` or `api/` is on `main`, start a run by hand. A branch
goes through `scripts/run-e2e.sh` (below). A
change to `infra/` needs `scripts/provision.sh dev` first.

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

To run a branch that is not on `main` yet, from your own machine as the Owner:

```bash
scripts/provision.sh dev    # when the branch changes the templates
scripts/run-e2e.sh dev
```

`scripts/run-e2e.sh` runs the workflow's code (`scripts/lib/e2e-job.sh`) from your working tree,
committed or not, but downloads nothing. It builds the site and the API (`npm ci`,
`npm run build`) and the image (in the registry, tagged `local-<commit>-<time>`), takes the lock,
deploys, starts the job, waits for the execution to end and releases the lock. The results go to
`runs/local-<time>/` in the `results` container. With `--no-wait` it returns once the job has marked
the lock as renewed by itself, and leaves the lock to the job. It refuses `prod`, and checks that the
site and the Function App it deploys to carry the tag `environment=<env>`.

A dev environment bootstrapped before the registry was added needs `scripts/provision.sh dev`
once, and then the registry's name as a variable of the GitHub Environment `dev`, which
`scripts/bootstrap.sh dev` sets, or by hand:

```bash
gh variable set E2E_REGISTRY --env dev --repo tgoodyear/atlasrelay --body "$(scripts/settings.sh dev E2E_REGISTRY)"
```

#### Reading the results

The run's summary page lists each test and its outcome. The repository is public and anyone signed
in to GitHub can download a run's artifacts, so the artifact `e2e-dev-gh-<run id>-<attempt>` holds
only a reduced `summary.json`: the outcome, the counts, the commit and each test's title and outcome,
with no errors. Everything else stays in the private `results` container, under
`runs/<run id>/`, for 30 days; the operator can read it (`az storage blob download-batch
--account-name <results account> -s results --pattern 'runs/<run id>/*' -d . --auth-mode login`).
The container holds:

- `summary.json`: the outcome, the counts, each test with its error, the image and commit, and
  which files were redacted;
- `report.json`: the Playwright report;
- `console.txt`: the suite's output, including the `[ripe]` lines with the amounts sent and
  returned and how each balance changed;
- `test-results/`: for a failed test, `error-context.md` (the page as the test saw it) and
  `trace.zip` (open it with `npx playwright show-trace trace.zip`). There are no screenshots,
  in the trace or beside it: a secret drawn into an image cannot be redacted, so the trace shows
  each page as a DOM snapshot instead;

When the execution did not succeed, the workflow prints the platform's events for it (image
pulled, container started, exit code) from Log Analytics in its log, which covers a container that
never started. The events take a few minutes to arrive.

Microsoft sign-in errors name the page they stopped on: "register" or "verify" means the account
has no TOTP seed in the vault, so give it one ([Test account TOTP seeds](#test-account-totp-seeds));
"change its password"
means the password expired or was reset, so sign in by hand, set a new one and run
`scripts/set-test-users.sh dev` again.

#### Test account TOTP seeds

Give each test account an
authenticator app with a TOTP seed (**Security info**, **Add sign-in method**, **Authenticator
app**, **I want to use a different authenticator app**, **Can't scan image?** shows the secret
key), then store the seed with the account:

```bash
E2E_RESEARCHER_TOTP=<secret key> E2E_DONOR_TOTP=<secret key> scripts/set-test-users.sh dev
```

The sign-in then answers the code prompt with a code computed from the seed (`e2e-real/lib/totp.mjs`).
Pass the seeds through a prompt of your own (`read -rs`) rather than typing them into the command
line, so they stay out of the shell history.

#### Removing it

`scripts/teardown.sh dev` removes the harness with the rest of dev: the network, the vault (purged
after it is deleted, so the same name can be used again at once), the registry, the job, the
environment and the results. It deletes the repository variable `DEV_ENABLED` first and the GitHub
Environment `dev` with its variables. The test tenant and the RIPE Atlas keys are outside Azure and
stay; delete the keys at https://atlas.ripe.net/keys/ and the test tenant by hand if dev will not
come back.

### Manual checks

A transfer made by hand on atlas.ripe.net and GitHub sign-in are not automated. Check them by hand
on a dev environment (`scripts/bootstrap.sh dev`, then upload the build to test as described under
[Dev environment](#dev-environment)), not on prod: they create projects, pledges and profiles, and
a transfer moves real credits. Use two browsers, or one normal and one private window, for the
researcher and the donor. Microsoft sign-in, the profile, a manual pledge, confirming it, posting
results, and API transfers with real credits are covered by the full-flow tests on dev.

1. **GitHub sign-in.** Click **Sign in**, sign in with a real GitHub account, and expect
   `/dashboard` with your username in the header. **Sign out** returns to the home page, signed out.
2. **Microsoft username.** Microsoft sends an email address as the username. Sign in with
   **Continue with Microsoft**, post a project without changing the display name, and check that
   the byline shows only the part before the `@`.
3. **Profile.** Save a display name and the RIPE NCC Access email of a real atlas.ripe.net
   account. That account is the researcher. Post a project asking for 1,000 credits.
4. **Manual transfer.** As the donor, signed in with another account, pledge 100 credits by hand,
   transfer the credits on https://atlas.ripe.net/credits/transfer/ to the email the dialog shows,
   and check both accounts' logs at https://atlas.ripe.net/credits/transactions/ a minute or two
   later.
5. **Clean up.** Delete both profiles on `/profile`, or remove the environment with
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

### Rebuilding a torn-down environment

Within the sign-in vault's 7-day retention, bootstrapping or provisioning the environment again
recovers the vault with its secrets and client ids, and records its name. Two things don't come
back, so a rebuild with sign-in registrations takes these steps by hand:

1. **Your access to the vault.** Its role assignments went with the resource group, so the run stops
   with `can't read signin-…-client-id` (or `can't list the secrets`). Grant yourself the role at
   the resource group, not the vault: the stack creates the vault's own assignment, and one made by
   hand at the same scope would collide with it.
   ```bash
   az role assignment create --role "Key Vault Secrets Officer" \
     --assignee "$(scripts/settings.sh <env> ATLASRELAY_OPERATOR_PRINCIPAL_ID)" \
     --scope "/subscriptions/$(scripts/settings.sh <env> AZURE_SUBSCRIPTION_ID)/resourceGroups/rg-atlasrelay-<env>"
   ```
   Wait a minute or two for it to apply, then run `scripts/provision.sh <env>` again.
2. **Microsoft's trust in the site.** The sign-in identity is new, and the Entra app's federated
   credential still names the old one, so Microsoft sign-in fails until
   `scripts/register-signin.sh <env> aad` points it at the new identity. Run it right after the
   provision.

Then remove the assignment from step 1 (`az role assignment delete` with the same arguments): the
stack's own assignment on the vault is in place by then. Automating both steps is a follow-up.

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
  Someone coming back from a first-time sign-in may show up with the provider (github.com, a
  Microsoft login host, accounts.google.com or orcid.org) as the referrer. Page views from before this was recorded show
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
  so the same account signing in again with the same provider is reconnected to that history; deletion
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
