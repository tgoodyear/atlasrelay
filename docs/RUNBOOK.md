# Runbook

## First deployment

Prerequisites: `az`, logged in as an Owner of the target subscription and with it
selected (`az account set -s <id>`), or with `SUBSCRIPTION_ID` exported. If the tenant
enforces MFA, use `az login --tenant <tenant-id>`. Also `gh` (logged in with `repo` and
`workflow` scopes), `jq`, and Node 22.12+. Set `GITHUB_REPO` to the repository that will
deploy (the script's default is this project's original name, not a fork), and export
`BUDGET_CONTACT_EMAIL`, which the script requires.

```bash
GITHUB_REPO=<owner>/<repo> BUDGET_CONTACT_EMAIL=you@example.org ./scripts/bootstrap.sh
```

The script is idempotent and creates nothing outside Bicep. It:

1. Checks prerequisites (az, gh, jq, Owner role) and registers the resource providers
   the templates use.
2. Reads the GitHub OIDC subject prefix of `GITHUB_REPO`.
3. Runs `az deployment sub create` with `infra/main.bicep`: resource group, CI managed
   identity with its GitHub federated credential, least-privilege custom role, Log
   Analytics and App Insights (`platform.bicep`), storage account
   and tables plus the static web app with its app settings (`app.bicep`), then the role
   assignment and delete locks (`rbac.bicep`). A failed first attempt is retried once
   after 45 s (custom-role replication lag).
4. Waits for the role assignment to be visible, then sets GitHub secrets
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (identifiers, not
   credentials), `BUDGET_CONTACT_EMAIL`, and the variable `AZURE_BOOTSTRAPPED`.
5. Prints the site hostname.

Role assignments can take a few minutes to propagate; if the first workflow run fails
with `AuthorizationFailed`, re-run it.

Then merge to `main` (or run the *Deploy* workflow manually) and the site goes live.

## Local development

```bash
npm install            # installs the web and api workspaces and local tooling
npm run dev            # Azurite + Functions host (:7071) + Vite (:5173) + SWA emulator (:4280)
```

`npm run dev` copies `api/local.settings.json.example` to `api/local.settings.json` if it
is missing; that file points `TABLES_CONNECTION_STRING` at Azurite. Open
http://localhost:4280. The SWA emulator lets you "log in" as any username without a real
GitHub account. Node 22.12 or newer is required; newer major versions work with a warning
from the Functions host. `func` comes from Azure Functions Core Tools v4, installed
separately (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Custom domain (atlasrelay.org)

The public DNS zone is Azure DNS, declared in `infra/dns.bicep` and deployed by the
Owner-only subscription deployment. Bicep is the only writer of the zone.

1. At the registrar, replace the nameservers with the four the zone
   reports: `az network dns zone show -n atlasrelay.org -g internetresearch --query nameServers -o tsv`.
2. Wait for the delegation to appear in public DNS: `dig +short NS atlasrelay.org @1.1.1.1`.
3. Bind the domain to the site: `./scripts/bind-custom-domain.sh`. It binds `www` by CNAME
   delegation and the apex by TXT token, then prints the apex validation token.
4. Put that token in `dnsApexTxtValues` in `infra/main.bicepparam` and re-run the
   subscription deployment, so a later deployment does not remove it.

`dev.atlasrelay.org` is not bound by that script. It is declared on the dev site and comes back
with it; see [Dev environment](#dev-environment).

### A hostname stuck at "Validating"

A hostname bound with the wrong validation method never recovers on its own, and the method
cannot be changed in place. `az staticwebapp hostname set` with a different `--validation-method`
returns 200 and changes nothing; the binding keeps its original method and its original token.

Check which method a hostname is using:

```bash
az staticwebapp hostname list -n swa-internetresearch -g internetresearch -o table
```

A populated `ValidationToken` means TXT-token validation. That works for the apex, whose token is
a TXT record on `@`, but it can never work for `www`, because the token would have to be a TXT
record at `www`, where the CNAME already lives, and DNS forbids a CNAME alongside any other
record at the same name. So `www` must use `cname-delegation`, which validates against the CNAME
that is already there.

The only fix is to recreate the binding, and the site carries a `CanNotDelete` lock, so:

```bash
SITE=$(az staticwebapp show -n swa-internetresearch -g internetresearch --query id -o tsv)
az lock delete --name no-delete --resource "$SITE"
az staticwebapp hostname delete -n swa-internetresearch -g internetresearch \
  --hostname www.atlasrelay.org --yes
az staticwebapp hostname set -n swa-internetresearch -g internetresearch \
  --hostname www.atlasrelay.org --validation-method cname-delegation
az lock create --name no-delete --lock-type CanNotDelete --resource "$SITE" \
  --notes "Production site. Remove the lock deliberately before deleting."
```

Restore the lock in the same sitting. It is declared in `infra/rbac.bicep`, so a subscription
deployment also restores it, but do not rely on that. The apex binding is untouched throughout.
With the CNAME already published, the new binding reaches `Ready` immediately and the
certificate is served within a minute.

### Apex routing

DNS forbids a CNAME at the apex and an Azure DNS alias record cannot target a static site, so
`infra/dns.bicep` declares an A record built from the site's `stableInboundIP`. The apex TXT
token only validates the hostname; it does not route it, and Static Web Apps creates no record
of its own. If the apex stops resolving, check this A record first. The binding script refuses
to run unless all four nameservers are delegated, and fails if a binding is rejected.

The zone also publishes a `www` CNAME to the site and records stating the domain sends no mail
(RFC 7505 null MX, `v=spf1 -all`, DMARC `p=reject`). Remove `rejectMail` if the domain ever
needs to send email.

### Canonical host

`https://www.atlasrelay.org` is the canonical host. The canonical tags, the sitemap and the
IndexNow submission all use it, and the README links it. `www` is a CNAME to the site's own
hostname, while the apex resolves through the A record described above.

`atlasrelay.org` serves the same pages until www is made the site's default domain. Static Web
Apps then answers every other hostname of the site, the apex and the `azurestaticapps.net` name
included, with a redirect to it. This is a one-time step for a subscription Owner, in the portal:
open `swa-internetresearch`, then **Custom domains**, select `www.atlasrelay.org`, and choose
**Set default**. The custom domain schema has no default-domain property, so Bicep cannot declare
it, and the CI role cannot write custom domains. Check it afterwards:

```bash
curl -sI 'https://atlasrelay.org/projects?status=all' | grep -iE '^(HTTP|location)'
# expect a permanent redirect to https://www.atlasrelay.org/projects?status=all
```

## Dev environment

`infra/dev.bicepparam` deploys a second, isolated copy of `app.bicep` into the same resource
group: `swa-internetresearch-dev`, its own storage account and tables, no App Insights, and
`dev.atlasrelay.org` bound to it. Nothing deploys it automatically. The Infrastructure workflow
deploys `infra/app.bicepparam` and nothing else, so dev is created and refreshed by hand, as a
subscription Owner:

```bash
az deployment group create \
  --name "dev-$(date +%Y%m%d%H%M%S)" \
  --resource-group internetresearch \
  --template-file infra/app.bicep \
  --parameters infra/dev.bicepparam
```

Run it as an Owner. The CI role denies `Microsoft.Web/staticSites/customDomains/write`, so the
binding in this file would fail from a workflow. If CI is ever given the dev environment to
deploy, that denial has to change in a way that keeps production's domains out of reach.

The subdomain takes two resources in two different deployments at two different scopes:

1. the `dev` CNAME, declared in `infra/dns.bicep` from `devStaticWebAppDefaultHostname` in
   `infra/main.bicepparam`, deployed by `scripts/bootstrap.sh`. That hostname is pasted in by
   hand, because the dev site is not created by the subscription deployment and so is not one of
   its outputs;
2. the binding, declared on the site itself as `customDomain` in `infra/dev.bicepparam`.

An existing dev site redeploys in one pass. A dev site created for the first time, or recreated
after a delete, comes up with a new `defaultHostname` and needs three steps:

```bash
# 1. deploy dev. The binding fails while the CNAME still points at the old site; everything else applies.
az deployment group create -g internetresearch --template-file infra/app.bicep --parameters infra/dev.bicepparam
# 2. read the new hostname, put it in devStaticWebAppDefaultHostname in infra/main.bicepparam,
#    and re-run the subscription deployment so the CNAME follows it.
az staticwebapp show -n swa-internetresearch-dev -g internetresearch --query defaultHostname -o tsv
GITHUB_REPO=<owner>/<repo> BUDGET_CONTACT_EMAIL=you@example.org ./scripts/bootstrap.sh
# 3. deploy dev again. The binding now validates.
az deployment group create -g internetresearch --template-file infra/app.bicep --parameters infra/dev.bicepparam
```

The dev deployment runs twice because Static Web Apps validates a `cname-delegation` binding
against public DNS rather than against the zone resource, so the record has to be published, and
its negative cache expired (the zone's SOA minimum is 300 s), before the binding can succeed. If
dev is being torn down for good, clear `customDomain` in `infra/dev.bicepparam` and
`devStaticWebAppDefaultHostname` in `infra/main.bicepparam` together: a CNAME left behind
resolves a name that still works to a site that no longer exists.

### What-if always reports the custom domain as modified

Against a dev deployment, `az deployment group what-if` shows the `customDomains` resource as
`Modify` on every run: `validationMethod` created, `expiresOn` and `isDefault` deleted. Nothing
is changing. `validationMethod` is write-only and never comes back from a GET, so what-if reads
it as new, while `expiresOn` (the certificate expiry) and `isDefault` are set by the service, so
what-if reads them as removed. The PUT is the same no-op as re-running `az staticwebapp hostname
set` against a binding that already exists. The Infrastructure workflow's what-if never prints
this, because `infra/app.bicepparam` binds nothing.

## Operations

- **Logs**: API logs and request telemetry go to App Insights `appi-internetresearch`
  (Log Analytics workspace `log-internetresearch`, 0.1 GB/day cap, 30-day retention).
  Bicep wires `APPLICATIONINSIGHTS_CONNECTION_STRING` into the SWA settings; do not set
  app settings by hand, the next infra deploy replaces the whole map. Extra settings go
  in the `additionalAppSettings` parameter.
- **Rotate storage keys without downtime**: the API reads key `storageKeyIndex`
  (0 = key1). Set `storageKeyIndex = 1` in both `.bicepparam` files and merge (the
  Infrastructure workflow deploys), renew key1 (`az storage account keys renew --key
  key1`), set the index back to 0 and merge, then renew key2. Renewing the key the API
  currently uses takes the API down until the next infra deploy.
- **Rotate SWA deploy token**: `az staticwebapp secrets reset-api-key` (an Owner; the
  CI role cannot). Nothing else to do; workflows fetch the token on every run.
- **Change app infra**: edit `infra/app.bicep` / `infra/app.bicepparam`, open a PR
  (Bicep lint + parameter-drift check), merge (what-if, then deploy on `main`). Keep the
  shared values in `infra/main.bicepparam` identical; `scripts/check-params.sh` fails
  otherwise.
- **Change platform infra** (resource group, identity, role, locks, monitoring):
  edit `infra/main.bicep` and its modules, then re-run `scripts/bootstrap.sh` as an Owner.
- **Trigger an infra run by hand**: `gh workflow run infra.yml`.
- **Data export**: `az storage entity query --table-name projects ...` or use Azure
  Storage Explorer.
- **Owner index rows**: the `projects` table holds two kinds of row. Projects are in partition
  `project`; each owner also has a partition `owner-<user id>` with one row per project they
  posted, which the open-project cap, the owner's dashboard and profile deletion read instead of
  scanning the table. Filter exports on `PartitionKey eq 'project'`.
- **Take a project down**: there is no admin console, so this is done against Table Storage.
  Closing a project stops it accepting credits and takes it off the listing. It is reversible,
  so prefer it to deleting anything.

  ```bash
  az storage entity merge --table-name projects --account-name <storage account> --auth-mode key \
    --entity PartitionKey=project RowKey=<project id> status=closed \
              moderationClosed=true moderationClosed@odata.type=Edm.Boolean
  ```

  Set both `status` and `moderationClosed`. With `status` alone the owner can reopen the project
  from the edit form; `moderationClosed` makes the API refuse that, and only this command can
  clear it (`moderationClosed=false`).

  To remove the owner as well, delete their row from `users`, which also removes the stored RIPE
  NCC Access email. Find the id from the project's `ownerId`, then:

  ```bash
  az storage entity show --table-name users --account-name <storage account> --auth-mode key \
    --partition-key user --row-key <owner id>
  az storage entity delete --table-name users --account-name <storage account> --auth-mode key \
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
    --account-name <storage account> --auth-mode key
  ```

  Several at once usually means RIPE was unreachable or slow. Check App Insights for a matching
  spike of 502s before changing anything.

## Search engines

- **Pages and status codes**: the build writes one HTML file per kind of page from
  `web/index.html` (`web/src/lib/pages.ts`, run from `web/vite.config.ts`): `index.html` for the
  home page, `shell/projects.html`, `shell/how-it-works.html`, `shell/project.html` for every
  project page, `shell/app.html` for the pages behind sign-in, and `404.html`. Each has its own
  title, description and canonical URL, and a line of text inside `#root` for clients that do not
  run JavaScript. `staticwebapp.config.json` rewrites each route to its file. There is no
  navigation fallback, so any other path gets `404.html` with a 404 status. Adding a route to
  `web/src/App.tsx` means adding a rule for it too; `web/test/seo.test.ts` fails until you do.
- **Project pages**: every path under `/projects/` returns 200 with the project shell, because
  the routing rules cannot tell a real project id from a wrong one. When the API says the project
  does not exist, the page adds `noindex` and shows "Project not found".
  The edit form at `/projects/<id>/edit` shares that shell. A route rule cannot match a segment
  after a wildcard, so `robots.txt` disallows `/projects/*/edit` instead, and the page adds
  `noindex` itself.
- **Trailing slashes**: `/projects/`, `/projects/new/`, `/how-it-works/`, `/dashboard/` and
  `/profile/` redirect with a 301 to the same path without the slash.
- **Sitemap**: `/sitemap.xml` is rewritten to `GET /api/sitemap`, which lists the home page, the
  project list, the how-it-works page and every project an operator has not taken down
  (`moderationClosed`). Responses may be cached for an hour. If storage fails it answers 503.
- **IndexNow**: after a production deploy, the `indexnow` job in `deploy.yml` reads the live
  sitemap and posts its URLs to `https://api.indexnow.org/indexnow`. The key is the name and the
  content of the 32-hex-digit `.txt` file in `web/public`. To rotate it, replace that file with a
  new one. The job logs problems as warnings and never fails the run.
- **Share image**: `web/public/og-image.png` is a 1200x630 screenshot of the home page hero,
  taken with Playwright with the statistics tiles and navigation hidden.

## Adding an admin role later

SWA Free supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
