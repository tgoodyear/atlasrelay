import { defineConfig, devices } from '@playwright/test';

// Browser tests (e2e/). They run against a production build made with a placeholder App Insights
// connection string, so the telemetry code is compiled in; the tests answer every request to the
// ingestion endpoint, /.auth and /api themselves, and nothing leaves the machine. The build goes to
// dist-e2e so it never mixes with the dist that CI deploys.
//
// The test-site project (e2e/test-site) runs against a second build made as dev's is, with
// VITE_SITE_ENV=dev (src/lib/siteEnv.ts), in dist-e2e-dev.
const PORT = 4173;
const TEST_SITE_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  // e2e/flows runs against the whole stack (playwright.flows.config.ts) and e2e/smoke against a
  // deployed site (playwright.smoke.config.ts), so neither belongs to this build-and-preview run.
  testIgnore: ['flows/**', 'smoke/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: ['flows/**', 'smoke/**', 'test-site/**'], use: { ...devices['Desktop Chrome'] } },
    { name: 'test-site', testMatch: 'test-site/**/*.spec.ts', use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${TEST_SITE_PORT}` } },
  ],
  webServer: [
    {
      command: `vite build --outDir dist-e2e --emptyOutDir && vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // Set even when the shell has it, so this build is always the production site.
        VITE_SITE_ENV: '',
        VITE_APPINSIGHTS_CONNECTION_STRING:
          'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://e2e.in.applicationinsights.azure.com/',
      },
    },
    {
      command: `vite build --outDir dist-e2e-dev --emptyOutDir && vite preview --outDir dist-e2e-dev --port ${TEST_SITE_PORT} --strictPort`,
      url: `http://localhost:${TEST_SITE_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_SITE_ENV: 'dev' },
    },
  ],
});
