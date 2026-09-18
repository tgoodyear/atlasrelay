# Contributing

This is a small community project. Issues and pull requests are welcome.

## Running it locally

```bash
npm install
npm run dev
```

That starts Azurite for local table storage, the Functions host, Vite, and the
Static Web Apps emulator on http://localhost:4280. The emulator lets you sign in
as any username without a real account. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Before you open a pull request

```bash
npm test          # API typecheck and unit tests, web typecheck
npm run build     # API emit and the Vite build
```

Infrastructure lives in `infra/*.bicep`. Changes to `app.bicep` deploy through
CI; the resource group, identity, roles, locks, monitoring, budget and DNS are
deployed only by a subscription owner running `scripts/bootstrap.sh`.

## Security

Please report vulnerabilities privately rather than in an issue. See
[SECURITY.md](SECURITY.md).
