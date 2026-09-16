# Atlas Credit Exchange

A lightweight platform for Internet research on [RIPE Atlas](https://atlas.ripe.net):
researchers post a project that needs measurement credits; Atlas users with spare
credits send them, either through the RIPE Atlas API (single-use, transfer-scoped API
key) or manually on atlas.ripe.net, and the recipient confirms.

The platform never holds credits or long-lived API keys. RIPE Atlas stays the ledger.

- Architecture and API spec: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What the RIPE Atlas docs allow (credits, transfers, identity): [docs/RIPE-ATLAS-NOTES.md](docs/RIPE-ATLAS-NOTES.md)
- Deploying and operating: [docs/RUNBOOK.md](docs/RUNBOOK.md)

## Stack

| Layer | Choice | Monthly cost |
| --- | --- | --- |
| Hosting + auth + API | Azure Static Web Apps (Free) with managed Azure Functions (Node 20) | $0 |
| Data | Azure Table Storage (Standard LRS) | ≈ $0.05 |
| CI/CD | GitHub Actions → SWA deploy token; Bicep via OIDC federated credential | $0 |
| Guardrail | Azure budget, $120 cap with alerts | $0 |

## Quick start

```bash
npm install
npm run dev        # http://localhost:4280 (SWA emulator + API + Azurite)
```

Deploy for the first time:

```bash
az login
./scripts/bootstrap.sh
```

Every push to `main` deploys; every pull request gets a preview environment.
