# Runbook

## First deployment

Prerequisites: `az`, logged in as an Owner of the target subscription and with it
selected (`az account set -s <id>`), or with `SUBSCRIPTION_ID` exported. If the tenant
enforces MFA, use `az login --tenant <tenant-id>`. Also `gh` (logged in with `repo` and
`workflow` scopes), `jq`, and Node 22.12+. Set `BUDGET_CONTACT_EMAIL` to the address that
should receive Azure budget alerts.

```bash
./scripts/bootstrap.sh
```

The script is idempotent and creates nothing outside Bicep. It:

1. Checks prerequisites (az, gh, jq, Owner role) and registers the resource providers
   the templates use.
2. Reads the repository's GitHub OIDC subject prefix and the budget start date (existing
   value if the budget already exists, else the current month).
3. Runs `az deployment sub create` with `infra/main.bicep`: resource group, CI managed
   identity with its GitHub federated credential, least-privilege custom role, Log
   Analytics + App Insights and the monthly budget (`platform.bicep`), storage account
   and tables plus the static web app with its app settings (`app.bicep`), then the role
   assignment and delete locks (`rbac.bicep`). A failed first attempt is retried once
   after 45 s (custom-role replication lag).
4. Waits for the role assignment to be visible, then sets GitHub secrets
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (identifiers, not
   credentials), the secret `BUDGET_CONTACT_EMAIL`, and the variable `AZURE_BOOTSTRAPPED`.
   The contact address is a secret rather than a variable because repository variables are
   world-readable once the repository is public.
5. Prints the site hostname.

Role assignments can take a few minutes to propagate; if the first workflow run fails
with `AuthorizationFailed`, re-run it.

Then merge to `main` (or run the *Deploy* workflow manually) and the site goes live.

## Local development

```bash
npm install            # installs web + api workspaces and local tooling
npm run dev            # Azurite + Functions host (:7071) + Vite (:5173) + SWA emulator (:4280)
```

`npm run dev` copies `api/local.settings.json.example` to `api/local.settings.json` if it
is missing; that file points `TABLES_CONNECTION_STRING` at Azurite. Open
http://localhost:4280. The SWA emulator lets you "log in" as any username without a real
GitHub account. Node 22.12 or newer is required (concurrently 10 needs it); newer local versions work
with a warning from the Functions host.

## Custom domain (atlasrelay.org)

The public DNS zone is Azure DNS, declared in `infra/dns.bicep` and deployed by the
Owner-only subscription deployment. Bicep is the only writer of the zone.

1. At the registrar (Squarespace), replace the nameservers with the four the zone
   reports: `az network dns zone show -n atlasrelay.org -g internetresearch --query nameServers -o tsv`.
2. Wait for the delegation to appear in public DNS: `dig +short NS atlasrelay.org @1.1.1.1`.
3. Bind the domain to the site: `./scripts/bind-custom-domain.sh`. It binds `www` by CNAME
   delegation and the apex by TXT token, then prints the apex validation token.
4. Put that token in `dnsApexTxtValues` in `infra/main.bicepparam` and re-run the
   subscription deployment, so a later deployment does not remove it.

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

This was run against `www.atlasrelay.org` on 2026-09-17. Rebinding with `cname-delegation`
returned `Ready` immediately, because the CNAME it validates against was already published, and
the DigiCert certificate was serving within a minute. Both hostnames now answer 200 over TLS.

The zone deliberately ships no apex A or ALIAS record. Static Web Apps creates that record
itself during apex validation, because only the service knows the target to point at; until
then the apex does not resolve while `www` already does. The binding script refuses to run
unless all four nameservers are delegated, and fails loudly if a binding is rejected.

The zone already publishes a `www` CNAME to the site, and records stating the domain sends
no mail (RFC 7505 null MX, `v=spf1 -all`, DMARC `p=reject`). Remove `rejectMail` if the
domain ever needs to send email. Azure DNS costs about $0.50 per zone per month plus
query charges.

## Operations

- **Logs**: API logs and request telemetry go to App Insights `appi-internetresearch`
  (Log Analytics workspace `log-internetresearch`, 0.1 GB/day cap, 30-day retention).
  Bicep wires `APPLICATIONINSIGHTS_CONNECTION_STRING` into the SWA settings; do not set
  app settings by hand, the next infra deploy replaces the whole map. Extra settings go
  in the `additionalAppSettings` parameter.
- **Budget**: `internetresearch-monthly` emails at 50% and 80% of actual spend and at
  100% of forecast against $120. It alerts only. The subscription (Visual Studio
  Enterprise credit) has its spending limit On, which disables the subscription, and
  therefore the site, if the monthly credit is exhausted. Expected spend is under $1.
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
- **Change platform infra** (resource group, identity, role, locks, monitoring, budget):
  edit `infra/main.bicep` and its modules, then re-run `scripts/bootstrap.sh` as an Owner.
- **Trigger an infra run by hand**: `gh workflow run infra.yml`.
- **Data export**: `az storage entity query --table-name projects ...` or use Azure
  Storage Explorer.
- **Take a project down**: there is no admin console, so this is done against Table Storage.
  Closing a project stops it accepting credits and takes it off the listing, which is the whole
  remedy; it is reversible, so prefer it to deleting anything.

  ```bash
  az storage entity merge --table-name projects --account-name <storage account> --auth-mode key \
    --entity PartitionKey=project RowKey=<project id> status=closed \
              moderationClosed=true moderationClosed@odata.type=Edm.Boolean
  ```

  Set `moderationClosed` as well as `status`, not instead of it. Closing alone is not a takedown:
  the owner can reopen their own project from the edit form, and would. The flag is what tells the
  API to refuse that, and only this command can clear it again (`moderationClosed=false`).

  To remove the owner as well, delete their row from `users`, which also removes the stored RIPE
  NCC Access email. Find the id from the project's `ownerId`, then:

  ```bash
  az storage entity show --table-name users --account-name <storage account> --auth-mode key \
    --partition-key user --row-key <owner id>
  az storage entity delete --table-name users --account-name <storage account> --auth-mode key \
    --partition-key user --row-key <owner id>
  ```

  Close every project they own first, using the command above: deleting the user alone would leave
  projects advertised as pledgeable that nobody can actually pledge to, because the handler needs
  the owner's address to name a recipient. Their projects and pledges stay, carrying only a display
  name, because other people's records point at them. The internal account id stays on those rows,
  so the same GitHub or Microsoft account signing in again is reconnected to that history rather
  than starting clean; deletion is not a ban. Note what you did and why in the abuse issue; pledges
  are the only audit trail there is.
- **A pledge stuck at "Sent, outcome unknown"**: the API posted a transfer and did not get an
  answer it could act on, so the platform cannot say whether the credits moved. Three things reach
  this state and they are worth telling apart: the request timed out, the connection failed, or
  RIPE answered with a 5xx. Only the last means RIPE replied at all, and none of them says whether
  the transfer was processed first. Only the requester can settle it, by confirming the pledge if
  the credits arrived or cancelling it if they never did. The donor cannot: cancelling frees their
  slot, and if the transfer did complete their next pledge would send the same credits again. Their
  part is to check https://atlas.ripe.net/credits/transactions/ and tell the requester what they
  find. Neither party needs an operator. If one is abandoned, the 14-day reservation expiry
  releases the capacity on its own, which is tracked as a defect rather than intended behaviour
  (issue #22). To find them:

  ```bash
  az storage entity query --table-name pledges --filter "transferUncertain eq true" \
    --account-name <storage account> --auth-mode key
  ```

  Several at once means RIPE was unreachable or slow, not that anything here is broken.
  Check for a matching spike of 502s in App Insights before changing anything.

## Adding an admin role later

SWA Free supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
