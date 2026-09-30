import { defineConfig, devices } from '@playwright/test';

// Full-flow tests against a deployed environment, signed in through the real Microsoft sign-in page
// (docs/RUNBOOK.md, "Full-flow tests on dev"). run.mjs starts this in the test job; see there for
// the variables. global-setup.ts signs both accounts in once, outside any trace or report, and the
// specs start from the saved browser states.
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('Set BASE_URL to the site under test, for example https://dev.atlasrelay.org');
const outputDir = process.env.E2E_OUTPUT_DIR ?? 'results';

export default defineConfig({
  testDir: 'specs',
  outputDir: `${outputDir}/test-results`,
  globalSetup: './global-setup.ts',
  // One flow, in order, against a shared site: no parallel runs and no retries, which would sign in
  // and write to the site again.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: `${outputDir}/report.json` }]],
  use: {
    baseURL,
    // Traces and screenshots are kept for a failing test only. Traces hold every request's Cookie
    // header; run.mjs replaces the session cookies in them before they leave the container.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
