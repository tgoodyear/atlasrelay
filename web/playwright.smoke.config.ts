import { defineConfig, devices } from '@playwright/test';

// Read-only smoke tests (e2e/smoke) against a deployed site:
//
//   BASE_URL=https://atlasrelay.org npm run test:smoke -w web
//
// They only send GET and HEAD requests, never sign in and never write anything, and they block the
// browser's App Insights requests so a run does not show up as traffic.
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('Set BASE_URL to the site to check, for example BASE_URL=https://atlasrelay.org');

export default defineConfig({
  testDir: 'e2e/smoke',
  outputDir: 'test-results/smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'smoke', use: { ...devices['Desktop Chrome'] } }],
});
