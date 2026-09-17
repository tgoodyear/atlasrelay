# Runbook

## First deployment

Prerequisites: `az` (logged in as an Owner of subscription
`25bf257c-c94e-4d61-bba3-edc635f46602`; the tenant requires MFA, so use
`az login --tenant <tenant-id>`), `gh` (logged in with `repo` and `workflow` scopes),
`jq`, Node 22+.

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
   credentials) and the variables `BUDGET_CONTACT_EMAIL` and `AZURE_BOOTSTRAPPED`.
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
GitHub account. Node 22 is the target runtime; newer local versions work with a warning
from the Functions host.

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

## Adding an admin role later

SWA Free supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
