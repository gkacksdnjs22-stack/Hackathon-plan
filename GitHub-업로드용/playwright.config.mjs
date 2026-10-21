import { defineConfig, devices } from '@playwright/test';

// A separate local server, browser profile and in-memory database; never reuse
// the user's development server, browser session, .env or saved account notes.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  outputDir: 'artifacts/browser-results',
  use: {
    baseURL: 'http://localhost:4179',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: 'http://localhost:4179/api/tour/areas',
    reuseExistingServer: false,
    timeout: 20_000
  }
});
