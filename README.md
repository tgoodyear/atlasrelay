# Atlas Relay

[atlasrelay.org](https://www.atlasrelay.org) connects Internet researchers who need
[RIPE Atlas](https://atlas.ripe.net) measurement credits with Atlas users who have credits to
spare. Researchers post a project; donors send credits through the RIPE Atlas API (with a
single-use, transfer-only key) or by hand on atlas.ripe.net, and the researcher confirms receipt.

Credits are donations. Nothing is bought or sold, and donors get nothing in return. The site
never holds credits or long-lived API keys; RIPE Atlas stays the ledger.

Atlas Relay is a community project and is not affiliated with or endorsed by the RIPE NCC.

## Run it locally

Needs Node 22 and [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local#install-the-azure-functions-core-tools)
(`func`) on your PATH; see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run dev        # http://localhost:4280 (SWA emulator + API + Azurite)
```

## How it is built

A React single-page app on Azure Static Web Apps, with its API in managed Azure Functions
(Node 22) and data in Azure Table Storage. All Azure resources are defined in Bicep under
`infra/`. GitHub Actions deploys every push to `main` using OIDC, with no stored Azure
credentials; pull requests only build, test and lint.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and API
- [docs/RIPE-ATLAS-NOTES.md](docs/RIPE-ATLAS-NOTES.md): what RIPE Atlas allows for credits and transfers
- [docs/RUNBOOK.md](docs/RUNBOOK.md): deploying your own instance and operating it

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security problems privately, as described in [SECURITY.md](SECURITY.md), rather than in a
public issue.

Licensed under the [MIT License](LICENSE).
