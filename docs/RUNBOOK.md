# Runbook

## Environments

Everything in Azure is one deployment stack per environment, `atlasrelay-<env>`, at subscription
scope, declared in `infra/main.bicep`. `prod` serves atlasrelay.org. `dev` is optional and is
deployed from the same template. Environment names are 1 to 6 lowercase letters and digits.

| Resource | prod | Declared in |
| --- | --- | --- |
| Resource group | `rg-atlasrelay-prod` | `infra/main.bicep` |
| Static Web App, with its app settings | `swa-atlasrelay-prod` | `infra/app.bicep` |
| Storage account with tables `users`, `projects`, `pledges`, `claims` | `statlasrelayprod<6 characters>` | `infra/app.bicep` |
| Log Analytics workspace | `log-atlasrelay-prod` | `infra/platform.bicep` |
| Application Insights | `appi-atlasrelay-prod` | `infra/platform.bicep` |
| Action group, log search alerts `alert-atlasrelay-prod-*`, availability test `webtest-atlasrelay-prod-home`, workbook "Atlas Relay" | `ag-atlasrelay-prod` | `infra/monitoring.bicep` |
| CI identity, federated with the GitHub Environment `prod` | `id-atlasrelay-prod-ci` | `infra/identity.bicep` |
| Custom role and its assignment to the CI identity | "Atlas Relay CI Deployer (prod)" | `infra/rbac.bicep` |
| Public DNS zone (prod only) | `atlasrelay.org` | `infra/dns.bicep` |

Every resource is tagged `project=atlasrelay` and `environment=<env>`. `dev` gets the same set
with `dev` in the names, no zone, and a `dev` CNAME in the prod zone (`infra/dns-subdomain.bicep`).

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

CI deploys no Bicep. The CI role can read the static web app and list its deployment token, and
nothing else. Every infrastructure change is a stack deployment by a subscription Owner.

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
   yet, and saves its outputs as settings.
4. Creates the GitHub Environment `prod` and restricts it to the `main` branch. The CI identity
   trusts only jobs in that GitHub Environment.
5. Sets the repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`
   (identifiers, not credentials) and the variables `AZURE_BOOTSTRAPPED` and
   `APPINSIGHTS_CONNECTION_STRING` (read by the Deploy workflow for browser telemetry).

Then deploy the site with `gh workflow run deploy.yml --ref main`, or merge to `main`. Role
assignments can take a few minutes to propagate; if that first run fails with
`AuthorizationFailed`, re-run it.

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
rebuilt site takes its record with it. The Deploy workflow uploads to prod only. To put a build on
dev, build and stage it as the workflow's build job does, then upload it with the dev site's token:

```bash
TOKEN=$(az staticwebapp secrets list -n swa-atlasrelay-dev -g rg-atlasrelay-dev \
  --subscription <id> --query properties.apiKey -o tsv)
npx swa deploy web/dist --api-location api-deploy --deployment-token "$TOKEN" --env production
```

`scripts/teardown.sh dev` removes it again, the CNAME included.

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

`scripts/teardown.sh <env>` deletes an environment: its stack, resource group, custom role and
GitHub Environment. For prod it also deletes the zone and removes the repository secrets, so the
Deploy workflow builds without deploying until prod is bootstrapped again. A new zone gets new
name servers, and the registrar has to be updated.

## Moving from the internetresearch resource group

Until this change the project ran in resource group `internetresearch`, deployed with
`az deployment sub create`. The new prod environment is built beside it and starts with empty
tables; nothing is copied from the old storage account.

| Old | New |
| --- | --- |
| `internetresearch` | `rg-atlasrelay-prod` |
| `swa-internetresearch` | `swa-atlasrelay-prod` |
| `swa-internetresearch-dev`, `stinternetresearchdevxw3` | `atlasrelay-dev` stack, not deployed by default |
| `stinternetresearchxw3aja` | `statlasrelayprod<6 characters>` |
| `log-internetresearch`, `appi-internetresearch` | `log-atlasrelay-prod`, `appi-atlasrelay-prod` |
| `ag-internetresearch`, `alert-internetresearch-*`, `webtest-internetresearch-home` | `ag-atlasrelay-prod`, `alert-atlasrelay-prod-*`, `webtest-atlasrelay-prod-home` |
| `id-internetresearch-ci` | `id-atlasrelay-prod-ci` |
| "Atlas Credit Exchange CI Deployer (internetresearch)" | "Atlas Relay CI Deployer (prod)" |
| zone `atlasrelay.org` in `internetresearch` | the same zone, moved to `rg-atlasrelay-prod` |

The zone moves to the new group and keeps its name servers, so the delegation at Squarespace
Domains stays as it is and no resolver ever sees a different set. Azure DNS would
also accept a second `atlasrelay.org` zone in the new group, but it would get different name
servers: the registrar would have to change, and until resolvers dropped the old delegation
(up to its TTL), some visitors would be answered by the old zone and some by the new one. After
the move, the prod stack's first deployment with `ATLASRELAY_DNS_ZONE` set takes the zone and its
records over in place, since they have the same resource ids as the ones it declares.

Once this change is merged, the Deploy workflow targets `swa-atlasrelay-prod` and the GitHub
Environment `prod`, so its runs fail until step 2 has run.

The new site shares the domain with the old one only if they are in different slices. When they
are, the apex is validated on the new site while the old one still serves it, and `www` moves
with a gap of about a minute. When they are not, both hostnames are down from step 6 until step 8
validates them.

Run from a checkout of `main`, as a subscription Owner, with `SUB` set to the subscription id:

1. At least an hour ahead (the records' TTL is 3600 s), shorten the TTL of the two records that
   will change:

   ```bash
   az network dns record-set a update -g internetresearch -z atlasrelay.org -n @ --set ttl=60 --subscription $SUB
   az network dns record-set cname update -g internetresearch -z atlasrelay.org -n www --set ttl=60 --subscription $SUB
   ```

2. Deploy the new environment, without the domain yet. This also points the GitHub secrets and
   variables at it:

   ```bash
   scripts/bootstrap.sh prod --subscription $SUB --alert-email <address>
   ```

3. Deploy the app, and wait for the run:

   ```bash
   gh workflow run deploy.yml --repo tgoodyear/atlasrelay --ref main
   gh run watch --repo tgoodyear/atlasrelay      # pick the Deploy run just started
   ```

4. Check the new site on its own hostname. The sitemap is served by the API from the tables:

   ```bash
   HOST=$(scripts/settings.sh prod SWA_HOSTNAME); echo "$HOST"
   curl -sI "https://$HOST/" | head -1                  # 200
   curl -s "https://$HOST/sitemap.xml" | head -3         # XML, not an error
   ```

   Sign in on `https://$HOST` and open the dashboard. Note the slice in `$HOST` (the number
   before `.azurestaticapps.net`). The old site is in slice 3.

5. Move the zone into the new group. Name servers and records are unchanged, and the old site
   keeps serving the domain:

   ```bash
   ZONE_ID=$(az network dns zone show -g internetresearch -n atlasrelay.org --subscription $SUB --query id -o tsv)
   az resource move --destination-group rg-atlasrelay-prod --ids "$ZONE_ID" --subscription $SUB
   az network dns zone show -g rg-atlasrelay-prod -n atlasrelay.org --subscription $SUB --query nameServers -o tsv
   # still ns1-07.azure-dns.com, ns2-07.azure-dns.net, ns3-07.azure-dns.org, ns4-07.azure-dns.info
   ```

   If Azure refuses the move because of a lock, remove the two `no-delete` locks in
   `internetresearch` first (`az lock list -g internetresearch --subscription $SUB`, then
   `az lock delete --ids <id>`); step 11 would remove them anyway.

6. Free or pre-validate the apex.
   - New site not in slice 3: validate the apex on it now. The script saves the token and prints
     the command that publishes it; run that command, then wait until `atlasrelay.org` is `Ready`
     on the new site:

     ```bash
     ZONE_NAME=atlasrelay.org scripts/bind-custom-domain.sh prod --apex-only
     az staticwebapp hostname list -n swa-atlasrelay-prod -g rg-atlasrelay-prod --subscription $SUB -o table
     ```

     Microsoft's zero-downtime instructions place the token at `_dnsauth` instead. If the apex
     is still `Validating` after 15 minutes, publish it there as well (and delete that record
     after step 10):

     ```bash
     az network dns record-set txt add-record -g rg-atlasrelay-prod -z atlasrelay.org -n _dnsauth \
       -v "$(scripts/settings.sh prod ATLASRELAY_SWA_APEX_TOKEN)" --subscription $SUB
     ```

   - New site in slice 3: the hostnames have to leave the old site first. The domain is down from
     here until step 8:

     ```bash
     az lock delete --name no-delete --subscription $SUB --resource \
       "$(az staticwebapp show -n swa-internetresearch -g internetresearch --subscription $SUB --query id -o tsv)"
     az staticwebapp hostname delete -n swa-internetresearch -g internetresearch --hostname www.atlasrelay.org --yes --subscription $SUB
     az staticwebapp hostname delete -n swa-internetresearch -g internetresearch --hostname atlasrelay.org --yes --subscription $SUB
     ```

7. Point the domain at the new site. The stack takes over the zone and rewrites the apex A
   record, the `www` CNAME and the apex TXT set (SPF, the Google token, the new site's apex token):

   ```bash
   scripts/settings.sh prod ATLASRELAY_DNS_TTL 60
   scripts/settings.sh prod ATLASRELAY_DNS_ZONE atlasrelay.org
   scripts/provision.sh prod
   dig +short atlasrelay.org A @ns1-07.azure-dns.com       # the new site's address
   dig +short www.atlasrelay.org CNAME @ns1-07.azure-dns.com
   ```

8. Bind both hostnames on the new site, and re-run until both are `Ready`:

   ```bash
   scripts/bind-custom-domain.sh prod
   ```

9. Make the apex the default domain in the portal: `swa-atlasrelay-prod`, **Custom domains**,
   `atlasrelay.org`, **Set default** ([Canonical host](#canonical-host)).

10. Check the domain, then put the TTL back:

    ```bash
    curl -sI https://atlasrelay.org/ | head -1                                   # 200
    curl -sI 'https://www.atlasrelay.org/projects?status=all' | grep -iE '^(HTTP|location)'
    curl -s https://atlasrelay.org/sitemap.xml | head -3
    scripts/settings.sh prod ATLASRELAY_DNS_TTL 3600
    scripts/provision.sh prod
    ```

11. Delete the old group. The script refuses while the zone is still in it, prints every
    resource it will delete, removes the delete locks, deletes the group, the old custom role and
    the `dev` CNAME that pointed at the old dev site, and asks for the group's name first:

    ```bash
    scripts/decommission-internetresearch.sh --subscription $SUB
    ```

Afterwards, remove `scripts/decommission-internetresearch.sh` and this section.

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
level. Those lines were about 80% of the traces in September 2026, most of them the storage health
check, which reports unhealthy on every start because managed functions have no
`AzureWebJobsStorage`.

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
Search Console has search queries. Static Web Apps Free keeps no access logs, so there is no
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

- **Logs**: see [Monitoring](#monitoring). Bicep wires `APPLICATIONINSIGHTS_CONNECTION_STRING`
  into the SWA settings; do not set app settings by hand, the next stack deployment replaces
  the whole map. Extra settings go in the `additionalAppSettings` parameter.
- **Rotate storage keys without downtime**: the API reads the key the setting
  `ATLASRELAY_STORAGE_KEY_INDEX` names (0 = key1). Run
  `scripts/settings.sh prod ATLASRELAY_STORAGE_KEY_INDEX 1` and `scripts/provision.sh prod`,
  renew key1 (`az storage account keys renew -g rg-atlasrelay-prod -n <storage account> --key
  primary`), set the index back to 0 and provision again, then renew key2 (`--key secondary`).
  Renewing the key the API currently uses takes the API down until the next deployment.
- **Rotate SWA deploy token**: `az staticwebapp secrets reset-api-key` (an Owner; the
  CI role cannot). Nothing else to do; workflows fetch the token on every run.
- **Change infrastructure**: see [Changing infrastructure](#changing-infrastructure).
- **Data export**: `az storage entity query --table-name projects ...` or use Azure
  Storage Explorer.
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

SWA Free supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
