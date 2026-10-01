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

Leave `VITE_SIGNIN_PROVIDERS` unset locally. With it set, the build adds the site's own sign-in
registrations to `staticwebapp.config.json`, and the emulator then sends you to the real
providers instead of its own sign-in page (docs/ARCHITECTURE.md, "Sign-in providers").

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

If you change the API, a page, or anything a donor or researcher does, run the full-flow tests.
They start the whole application on your machine: Azurite with empty tables, the Functions host
running the built API, the built site behind the Static Web Apps emulator, and a stub of the RIPE
Atlas API (`web/e2e/flows/harness/ripe-stub.ts`) in place of atlas.ripe.net. Tests sign in
through the emulator as made-up GitHub and Microsoft users, and every API key they use is a fake
one starting `00000000-0000-4000-8000-`. They need a fresh build and `func`:

```bash
npm run build
npm run test:flows -w web                 # or FUNC=/path/to/func npm run test:flows -w web
```

The stack uses ports 4380 (site), 7171 (API), 4390 (RIPE Atlas stub) and 10100 to 10102
(Azurite), so it can run beside `npm run dev`. Its logs are in `web/e2e-stack/`. To keep it up
and click around, run `npm run e2e:stack -w web`, then open http://localhost:4380. With
`E2E_REUSE_STACK=1`, `test:flows` uses that stack instead of starting its own.

The page steps the full-flow tests share live in `web/e2e/ui.ts`. The tests in `e2e-real/` use
them too: they run the same flow on the dev environment with real Microsoft sign-in and real RIPE
Atlas transfers, in Azure, after a merge or, for the Owner, from a branch with
`scripts/run-e2e.sh` (docs/RUNBOOK.md, "Full-flow tests on dev"). A pull request cannot run them.
`npm test` covers their redaction (with fake RIPE Atlas keys, and a real browser trace when
Chromium is installed), TOTP, RIPE Atlas client and summary code, and checks that the test image
and `web/package.json` use the same Playwright version; the Full-flow test image workflow builds
the image on a pull request that changes it.

Infrastructure lives in `infra/*.bicep`. CI builds and lints it but deploys none of it: a
subscription owner deploys each environment's stack with `scripts/provision.sh` after the merge
(see [docs/RUNBOOK.md](docs/RUNBOOK.md#changing-infrastructure)). Before pushing a change there,
run `scripts/check-params.sh` and `az bicep lint --file` on the templates you touched.

## Security

Please report vulnerabilities privately rather than in an issue; see
[SECURITY.md](SECURITY.md).
