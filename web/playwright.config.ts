import { defineConfig, devices } from '@playwright/test';

// Browser tests (e2e/). They run against a production build made with a placeholder App Insights
// connection string, so the telemetry code is compiled in; the tests answer every request to the
// ingestion endpoint, /.auth and /api themselves, and nothing leaves the machine. The build goes to
// dist-e2e so it never mixes with the dist that CI deploys.
const PORT = 4173;

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `vite build --outDir dist-e2e --emptyOutDir && vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_APPINSIGHTS_CONNECTION_STRING:
        'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://e2e.in.applicationinsights.azure.com/',
    },
  },
});
