# Contributing

This is a small community project. Issues and pull requests are welcome.

## Running it locally

Install [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local#install-the-azure-functions-core-tools)
so that `func` is on your PATH, for example `brew install azure/functions/azure-functions-core-tools@4`
on macOS or `winget install Microsoft.Azure.FunctionsCoreTools` on Windows. It is not an npm
dependency: the npm package unpacks its binary with extract-zip, which has an unpatched
path-traversal advisory.

```bash
npm install
npm run dev
```

That starts Azurite for local table storage, the Functions host, Vite, and the
Static Web Apps emulator on http://localhost:4280. The emulator lets you sign in
as any username without a real account.

## Before you open a pull request

```bash
npm test          # API typecheck and unit tests, web typecheck
npm run build     # the Vite build, then the API bundle, which embeds two of the built pages
```

If you change `web/src/lib/telemetry.ts` or a sign-in link, also run the browser tests. They build
the site with a placeholder App Insights connection string and answer every request themselves:

```bash
npx -w web playwright install chromium   # once
npm run test:e2e -w web
```

Infrastructure lives in `infra/*.bicep`. CI builds and lints it but deploys none of it: a
subscription owner deploys each environment's stack with `scripts/provision.sh` after the merge
(see [docs/RUNBOOK.md](docs/RUNBOOK.md#changing-infrastructure)). Before pushing a change there,
run `scripts/check-params.sh` and `az bicep lint --file` on the templates you touched.

## Security

Please report vulnerabilities privately rather than in an issue; see
[SECURITY.md](SECURITY.md).
