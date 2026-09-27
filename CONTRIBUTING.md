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
npm run build     # API emit and the Vite build
```

Infrastructure lives in `infra/*.bicep`. Changes to `app.bicep` deploy through
CI; the resource group, identity, roles, locks, monitoring and DNS are deployed
only by a subscription owner running `scripts/bootstrap.sh`.

## Security

Please report vulnerabilities privately rather than in an issue; see
[SECURITY.md](SECURITY.md).
