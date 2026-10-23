import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the real stack: `make up` (or `make e2e`).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.POS_E2E_URL ?? 'http://localhost:8080',
    // An iPad Air in landscape.
    viewport: { width: 1180, height: 820 },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
});
