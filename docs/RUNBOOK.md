# Runbook

## First deployment

Prerequisites: `az` (logged into the account that owns subscription
`25bf257c-c94e-4d61-bba3-edc635f46602`), `gh` (logged in with `repo` and `workflow`
scopes), Node 20+.

```bash
az login   # pick the tenant that contains the subscription
./scripts/bootstrap.sh
```

The script is idempotent. It:

1. Creates resource group `internetresearch` (default location `eastus2`).
2. Deploys `infra/main.bicep` (storage account, tables, static web app, budget).
3. Writes the storage connection string into the SWA app settings as
   `TABLES_CONNECTION_STRING`.
4. Creates/reuses an Entra app `gh-internetresearch-infra` with a federated credential
   for `main` and for pull requests, grants it Contributor on the resource group.
5. Sets GitHub secrets: `AZURE_STATIC_WEB_APPS_API_TOKEN`, `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
6. Prints the site hostname.

Then merge to `main` (or run the *Deploy* workflow manually) and the site goes live.

## Local development

```bash
npm install            # installs web + api workspaces
npm run dev            # SWA CLI: web on :5173 via :4280, API on :7071, auth emulator
```

`npm run dev` starts Azurite (local table storage) too; `api/local.settings.json` points
`TABLES_CONNECTION_STRING` at it. Open http://localhost:4280. The SWA emulator lets you
"log in" as any username without a real GitHub account.

## Operations

- **Logs**: SWA managed functions have no logs without Application Insights. To turn it
  on, create an App Insights resource and set `APPLICATIONINSIGHTS_CONNECTION_STRING`
  in the SWA app settings (first 5 GB/month free).
- **Budget**: `internetresearch-monthly` emails at 50/80/100% of $120. Expected spend
  is under $1.
- **Rotate storage key**: `az storage account keys renew`, then re-run
  `scripts/bootstrap.sh` (it re-reads key1 and updates the SWA setting).
- **Rotate SWA deploy token**: `az staticwebapp secrets reset-api-key`, then re-run
  bootstrap (it re-uploads the GitHub secret).
- **Data export**: `az storage entity query --table-name projects ...` or use Azure
  Storage Explorer.

## Adding an admin role later

SWA Free supports role invitations from the portal (Settings → Role management).
Invite yourself with role `admin`; then a route rule `"allowedRoles": ["admin"]` and a
check on `userRoles` in the API can gate moderation endpoints.
