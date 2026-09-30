import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/flows/harness/env';

// Full-flow tests (e2e/flows) against the real stack on this machine: Azurite, the Functions host
// running the built API, the built site behind the Static Web Apps emulator, and a stub of the
// RIPE Atlas API. e2e/flows/harness/stack.ts starts all of it. Needs `npm run build` first and
// Azure Functions Core Tools v4 (`func` on PATH, or FUNC=/path/to/func).
//
// The read-only smoke tests (e2e/smoke) run here too, against the same local stack, so they are
// exercised on every pull request before anyone points them at a deployed site.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/flows',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  // One test waits out the API's 20 second transfer deadline.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'flows', testMatch: 'flows/**/*.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'smoke', testMatch: 'smoke/**/*.spec.ts', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node --import tsx e2e/flows/harness/stack.ts',
    url: `${BASE_URL}/api/stats`,
    // Every run gets empty tables, so an already running stack is only reused when asked for.
    reuseExistingServer: process.env.E2E_REUSE_STACK === '1',
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
  },
});
