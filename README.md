# Atlas Credit Exchange

A lightweight platform for Internet research on [RIPE Atlas](https://atlas.ripe.net):
researchers post a project that needs measurement credits; Atlas users with spare
credits send them, either through the RIPE Atlas API (single-use, transfer-scoped API
key) or manually on atlas.ripe.net, and the recipient confirms.

The platform never holds credits or long-lived API keys. RIPE Atlas stays the ledger.

RIPE Atlas runs about 12,900 probes and 810 anchors in 178 countries and produces 1.3
billion results a day. Anyone can launch their own measurements if they hold enough
credits, each user has a daily spend limit that defaults to 1M credits but is set per
account and can be raised on request, and the user-defined
measurements that credits pay for make up about 11% of the platform's output (Nosyk et
al., [*Day in the Life of RIPE Atlas*](https://arxiv.org/abs/2511.22474), 2025).

- Architecture and API spec: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What the RIPE Atlas docs allow (credits, transfers, identity): [docs/RIPE-ATLAS-NOTES.md](docs/RIPE-ATLAS-NOTES.md)
- Deploying and operating: [docs/RUNBOOK.md](docs/RUNBOOK.md)

## Stack

| Layer | Choice | Monthly cost |
| --- | --- | --- |
| Hosting + auth + API | Azure Static Web Apps (Free) with managed Azure Functions (Node 22) | $0 |
| Data | Azure Table Storage (Standard LRS) | ≈ $0.05 |
| Logs | App Insights + Log Analytics, capped at 0.1 GB/day | $0 (free allowance) |
| CI/CD | GitHub Actions with OIDC through a user-assigned managed identity; all resources in Bicep | $0 |
| Guardrail | Azure budget with alerts at $120; subscription spending limit as the hard stop | $0 |

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security problems privately rather than in an issue, as described in [SECURITY.md](SECURITY.md).
Licensed under the [MIT License](LICENSE).

## Quick start

```bash
npm install
npm run dev        # http://localhost:4280 (SWA emulator + API + Azurite)
```

Deploy for the first time, as an owner of the target subscription:

```bash
BUDGET_CONTACT_EMAIL=you@example.org ./scripts/bootstrap.sh
```

No subscription id or contact address is stored in this repository; the script reads the
subscription you have selected and takes the alert address from the environment.

Every push to `main` deploys; pull requests build, test and lint only.
