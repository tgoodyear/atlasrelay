# Atlas Relay

[atlasrelay.org](https://atlasrelay.org) connects Internet researchers who need
[RIPE Atlas](https://atlas.ripe.net) measurement credits with Atlas users who have credits to
spare. Researchers post a project, and donors send credits in one of two ways. Donors can
transfer through the RIPE Atlas API with a single-use, transfer-only key, and the pledge is
normally confirmed as soon as RIPE accepts the transfer. Donors can also transfer by hand on
atlas.ripe.net, and the researcher then confirms receipt.

Credits are donations. Nothing is bought or sold, and donors get nothing in return. The site
never holds credits or long-lived API keys, and every transfer happens in RIPE Atlas.

Atlas Relay is a community project and is not affiliated with or endorsed by the RIPE NCC.

## Run it locally

Needs Node 22.12 or later and [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local#install-the-azure-functions-core-tools)
(`func`) on your PATH; see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run dev        # http://localhost:4280 (SWA emulator + API + Azurite)
```

## How it is built

A React single-page app on Azure Static Web Apps, with its API in managed Azure Functions
(Node 22) and data in Azure Table Storage. All Azure resources are defined in Bicep under
`infra/` and deployed as one deployment stack per environment by `scripts/bootstrap.sh` and
`scripts/provision.sh`. GitHub Actions deploys the site and API from `main` using OIDC, with no
stored Azure credentials. Pushes that touch only docs or infrastructure deploy nothing, and pull
requests only build, test and lint.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and API
- [docs/RIPE-ATLAS-NOTES.md](docs/RIPE-ATLAS-NOTES.md): what RIPE Atlas allows for credits and transfers
- [docs/RUNBOOK.md](docs/RUNBOOK.md): deploying your own instance and operating it

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security problems privately, as described in [SECURITY.md](SECURITY.md), rather than in a
public issue.

Licensed under the [MIT License](LICENSE).

## Third-party notices

The site serves its own copies of two fonts, both under the SIL Open Font License 1.1:
[Inter](https://github.com/rsms/inter) ([license](https://github.com/rsms/inter/blob/master/LICENSE.txt))
and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) ([license](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt)).
The license text also ships in each font's `@fontsource` package.
