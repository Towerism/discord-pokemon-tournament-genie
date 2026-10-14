import { defineConfig, devices } from '@playwright/test';

/** Fixed so the browser's origin is known before global setup starts the app: http://localhost is allowed (ADR-0013). */
export const E2E_PORT = Number(process.env.GENIE_E2E_PORT ?? 3901);

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // One retry in CI; a retried pass is reported as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
